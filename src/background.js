// Background service worker — single source of truth for sync & cookie auth
// NOTE: Must NOT use dynamic import() in ServiceWorker scope (banned per HTML spec).
// All imports are static at top level.
import { fetchQuota, fetchUsagePage, fetchKeyNames, resolveWorkspaceId, AuthError } from "./lib/api.js";
import { bulkPutRecords, pruneOldRecords, clearAllRecords, getExistingUsgIds, getRecordsForMinute, deleteRecordsFromMinute, getMinuteSummary, getAllRecords, countRecords } from "./lib/db.js";

const SYNC_STATE_KEY="syncState";
const SETTINGS_KEY="settings";
const QUOTA_KEY="quotaCache";

let syncState={
  running:false, mode:"", page:0, inserted:0, phase:"idle", message:"", account:"",
  totalPages:0, progress:0
};
let quotaCache=null; // {at, data}
const QUOTA_TTL=30*1000;
let abortFlag=false;
let mismatchResolver=null;
let mismatchPendingDetails=null;

function nowIso(){ return new Date().toISOString(); }
async function getSettings(){
  const r=await chrome.storage.local.get(SETTINGS_KEY);
  const base = r[SETTINGS_KEY] || { windowDays: 90, theme:"light", lang:"zh", turbo:false };
  if(base.turbo===undefined) base.turbo=false;
  return base;
}
async function saveSettings(patch){
  const cur=await getSettings();
  const next={...cur, ...patch};
  await chrome.storage.local.set({[SETTINGS_KEY]: next});
  return next;
}
function setSyncState(patch){
  Object.assign(syncState, patch);
  // broadcast — ignore "no receiver" error
  try{ chrome.runtime.sendMessage({type:"SYNC_STATE", state:{...syncState}}).catch(()=>{}); }catch{}
  chrome.storage.local.set({[SYNC_STATE_KEY]: syncState}).catch(()=>{});
}

// Check auth cookie — looks for `auth` cookie on opencode.ai
async function checkAuth(){
  try{
    // try direct `auth`
    let c=await chrome.cookies.get({url:"https://opencode.ai/", name:"auth"});
    if(c && c.value) return { loggedIn:true, value:c.value, cookie:c };
    // fallback: scan all cookies for opencode.ai containing auth
    const all=await chrome.cookies.getAll({domain:"opencode.ai"});
    for(const ck of all){
      if(ck.name==="auth" && ck.value) return { loggedIn:true, value:ck.value, cookie:ck };
      if(ck.name.toLowerCase().includes("auth") && ck.value) return { loggedIn:true, value:ck.value, cookie:ck };
    }
    const all2=await chrome.cookies.getAll({url:"https://opencode.ai"});
    for(const ck of all2){
      if(ck.name==="auth") return { loggedIn:!!ck.value, value:ck.value, cookie:ck };
    }
    return { loggedIn:false, value:"", cookie:null, allCookies: all.map(x=>x.name) };
  }catch(e){
    return { loggedIn:false, error:String(e)};
  }
}
async function ensureAuthOrThrow(){
  const a=await checkAuth();
  if(!a.loggedIn) throw new AuthError("未登录 OpenCode，请先在浏览器中登录 https://opencode.ai");
  return a;
}

async function fetchQuotaWithCache(workspaceHint){
  const now=Date.now();
  if(quotaCache && now - quotaCache.at < QUOTA_TTL) return quotaCache.data;
  const data=await fetchQuota(workspaceHint || "Default");
  quotaCache={at:now, data};
  await chrome.storage.local.set({[QUOTA_KEY]: quotaCache});
  return data;
}
async function loadQuotaCache(){
  const r=await chrome.storage.local.get(QUOTA_KEY);
  if(r[QUOTA_KEY]) quotaCache=r[QUOTA_KEY];
}

async function getWorkspaceIdHint(){
  const r=await chrome.storage.local.get("workspaceId");
  return r.workspaceId || "Default";
}
async function saveWorkspaceId(id){
  await chrome.storage.local.set({workspaceId:id});
}

// Batch fetch helper
async function fetchUsageBatch(workspaceId, pages){
  const promises=pages.map(p=> fetchUsagePage(workspaceId, p).then(records=>({page:p, records})).catch(error=>({page:p, error})));
  const results=await Promise.all(promises);
  const map=new Map();
  for(const r of results) map.set(r.page, r);
  return map;
}
async function estimatePerPageBytes(workspaceId){
  try{
    const sample=await fetchUsagePage(workspaceId, 0);
    if(!sample.length) return 15*1024;
    const jsonLen = JSON.stringify(sample).length;
    // IndexedDB 开销约 1.3 倍
    return Math.max(8*1024, Math.ceil(jsonLen * 1.3));
  }catch{ return 15*1024; }
}
async function getCurrentDbBytes(){
  try{
    if(navigator.storage && navigator.storage.estimate){
      const est=await navigator.storage.estimate();
      if(est && typeof est.usage==="number") return est.usage;
    }
  }catch{}
  try{
    const cnt=await countRecords();
    return cnt * 12 * 1024; // 回退：按 12KB/条估
  }catch{ return 0; }
}
async function findTotalPages(workspaceId, maxGuess=2048){
  // 指数探测：2048→4096→8192... 直到空页，同时受 100MB 硬盘上限约束
  const LIMIT_BYTES = 100 * 1024 * 1024;
  const perPage = await estimatePerPageBytes(workspaceId);
  const currentBytes = await getCurrentDbBytes();
  const remaining = Math.max(0, LIMIT_BYTES - currentBytes);
  const maxPagesBySize = Math.floor(remaining / perPage);
  // 若剩余空间已不足一页，直接提示
  if(maxPagesBySize < 1){
    setSyncState({message:`本地已占用约 ${(currentBytes/1024/1024).toFixed(1)}MB，接近 100MB 上限`, progress:13});
    return 0;
  }
  setSyncState({message:`正在探测总页数…(预估每页 ${(perPage/1024).toFixed(1)}KB，剩余可写入 ~${maxPagesBySize} 页)`, progress:12});
  try{
    const first=await fetchUsagePage(workspaceId, 0);
    if(!first.length) return 0;
  }catch{ return 0; }
  let low=0;
  let high=Math.min(maxGuess, maxPagesBySize);
  let highRecs=[];
  try{ highRecs=await fetchUsagePage(workspaceId, high); }catch{ highRecs=[]; }
  let doublings=0;
  while(highRecs.length>0 && high < maxPagesBySize && high < 50000){
    if((high * perPage + currentBytes) >= LIMIT_BYTES){
      setSyncState({message:`已触及 100MB 上限，探测止于 ${high} 页`, progress:14});
      break;
    }
    low=high;
    high=Math.min(high*2, maxPagesBySize);
    if(high<=low) break;
    setSyncState({message:`探测上限 ${low}→${high} 页…(100MB 约 ${maxPagesBySize} 页)`, progress:13});
    try{ highRecs=await fetchUsagePage(workspaceId, high); }catch{ highRecs=[]; }
    doublings++;
    if(doublings>10) break;
    await new Promise(r=>setTimeout(r, 200));
  }
  // 二分在 [low, high] 之间
  let steps=0;
  while(high - low > 1 && steps < 25){
    const mid=Math.floor((low+high)/2);
    // 若 mid 超过 100MB 限制，直接视为空
    if((mid * perPage + currentBytes) >= LIMIT_BYTES){
      high=mid;
      steps++;
      continue;
    }
    setSyncState({message:`二分探测 ${low+1}–${high} → 试 ${mid}…`, progress:13 + Math.round((steps/14)*2)});
    let recs=[];
    try{ recs=await fetchUsagePage(workspaceId, mid); }catch{ recs=[]; }
    if(recs.length===0) high=mid;
    else low=mid;
    steps++;
    await new Promise(r=>setTimeout(r, 80));
  }
  let total=low+1;
  // 最终再按 100MB 截断
  const maxAllowed = Math.floor(remaining / perPage);
  if(total > maxAllowed){
    total = maxAllowed;
    setSyncState({message:`探测完成：共 ${low+1} 页，但受 100MB 限制截断为 ${total} 页`, progress:15, totalPages: total});
  } else {
    setSyncState({message:`探测完成：共 ${total} 页 (预估 ${(total*perPage/1024/1024).toFixed(1)}MB)`, progress:15, totalPages: total});
  }
  return total;
}

// Main sync — only starts on user click (mandatory)
async function runSync(mode="incremental"){
  if(syncState.running) return {ok:false, error:"同步进行中"};
  abortFlag=false;
  const settings=await getSettings();
  const windowDays= settings.windowDays ?? 90; // null means all
  setSyncState({running:true, mode, phase:"quota", message:"正在检查登录状态…", inserted:0, page:0, progress:2});

  try{
    const auth=await ensureAuthOrThrow();
    setSyncState({message:"正在解析工作区…", progress:5});
    let workspaceHint=await getWorkspaceIdHint();
    let workspaceId=workspaceHint;
    try{
      workspaceId=await resolveWorkspaceId(workspaceHint, workspaceHint);
      if(workspaceId !== workspaceHint) await saveWorkspaceId(workspaceId);
    }catch(e){
      setSyncState({phase:"error", running:false, message:String(e.message||e)});
      return {ok:false, error:String(e.message||e)};
    }
    // fetch quota (non-blocking but we show)
    setSyncState({message:"正在获取配额窗口…", progress:10});
    try{
      const quota=await fetchQuotaWithCache(workspaceHint);
      await chrome.storage.local.set({lastQuota: quota});
    }catch(e){
      console.warn("[GoGauge] quota fetch failed", e);
    }
    // optional key names
    setSyncState({phase:"usage", message:`正在拉取用量记录 ${settings.turbo?"(极速×10)":""} (工作区 ${workspaceId.slice(0,10)}…)`, progress:14});
    let keyNames={};
    try{ keyNames=await fetchKeyNames(workspaceId); if(Object.keys(keyNames).length) await chrome.storage.local.set({keyNames}); }catch{}

    let MAX_FULL_PAGES=0; // 全量由二分探测决定，无固定 2000 上限
    // 增量改为动态：不再固定 5/10 页，而是拉到与本地重叠为止；受 100MB 限制
    let FETCH_BATCH=settings.turbo ? 10 : 5;
    let SLEEP_MS=settings.turbo ? 0 : 120;
    let maxPages = 0;
    let totalPagesProbed = null;
    if(mode==="full"){
      try{
        totalPagesProbed=await findTotalPages(workspaceId, 2048);
        if(totalPagesProbed>0){
          MAX_FULL_PAGES=totalPagesProbed;
          maxPages=totalPagesProbed;
          // 极速下提升并发，100MB 内尽量一次拉完
          FETCH_BATCH = settings.turbo ? 30 : 15;
          SLEEP_MS = 0;
        } else {
          maxPages=0;
        }
      }catch(e){
        console.warn("findTotalPages failed", e);
        maxPages=0;
      }
    } else {
      // 增量：上限由 100MB 决定，实际会提前在重叠点结束
      maxPages=50000; // 逻辑上限，实际受 100MB 与重叠点截断
      FETCH_BATCH=settings.turbo ? 10 : 5;
    }
    let page=0;
    let totalInserted=0;
    let deepestPageFetched=-1;
    let windowBoundaryReached=false;
    let consecutiveEmptyBatches=0;
    let foundOverlap=false;
    // 预加载本地 usg_id 集合用于快速判重（首次增量时）
    let localUsgSet=new Set();
    let minuteCache=new Map(); // minute -> {count, tokenSum, costRaw}
    if(mode==="incremental"){
      try{
        const allLocal = await getAllRecords();
        for(const r of allLocal){
          localUsgSet.add(r.usg_id);
          const minute = r.created_at ? r.created_at.slice(0,16) : "";
          if(minute){
            let entry=minuteCache.get(minute);
            if(!entry) minuteCache.set(minute, {count:0, tokenSum:0, costRaw:0});
            entry.count++;
            entry.tokenSum += (r.input_tokens||0)+(r.output_tokens||0)+(r.cache_read_tokens||0);
            entry.costRaw += (r.cost_raw||0);
          }
        }
      }catch(e){ console.warn("preload local cache failed", e); }
    }

    while(page < maxPages){
      if(abortFlag){
        setSyncState({phase:"error", running:false, message:"已取消"});
        return {ok:false, error:"已取消", partialInserted:totalInserted, canceled:true};
      }
      const batchPages=[...Array(Math.min(FETCH_BATCH, maxPages-page))].map((_,i)=> page+i);
      // 进度：增量时按已拉页数估算，全量时按 maxPages
      let progBase = mode==="full" ? 15 + Math.round((page/maxPages)*70) : 15 + Math.min(70, Math.round((page/200)*70));
      const totalForMsg = (mode==="full" && maxPages) ? ` / 共 ${maxPages} 页` : "";
      if(mode==="full") setSyncState({page, totalPages: maxPages, message:`正在拉取第 ${page+1}–${page+batchPages.length}${totalForMsg}…`, progress: progBase });
      else setSyncState({page, message:`正在拉取第 ${page+1}–${page+batchPages.length}…`, progress: progBase });
      const batchMap=await fetchUsageBatch(workspaceId, batchPages);
      let batchInserted=0;
      let batchFullPages=0;
      let batchFailed=0;
      let batchHasOverlap=false;
      let batchMismatchMinute=null;
      let batchMismatchInfo=null;
      for(const p of batchPages){
        const res=batchMap.get(p);
        if(!res || res.error){
          batchFailed++;
          console.warn("[GoGauge] page",p,"failed",res && res.error);
          continue;
        }
        const records=res.records || [];
        if(!records.length){
          continue;
        }
        if(records.length >= 50) batchFullPages++;
        deepestPageFetched=Math.max(deepestPageFetched, p);
        let toStore=records;
        if(mode==="full" && windowDays){
          const boundary=Date.now() - windowDays*24*3600*1000;
          const earliest=Math.min(...records.map(r=> new Date(r.created_at).getTime()));
          if(earliest < boundary){
            windowBoundaryReached=true;
          }
        }
        const dbRecs=toStore.map(r=>({
          usg_id:r.usg_id, created_at:r.created_at, model:r.model, provider:r.provider,
          input_tokens:r.input_tokens||0, output_tokens:r.output_tokens||0, reasoning_tokens:r.reasoning_tokens||0,
          cache_read_tokens:r.cache_read_tokens||0, cache_write_5m_tokens:r.cache_write_5m_tokens||0, cache_write_1h_tokens:r.cache_write_1h_tokens||0,
          cost_raw:r.cost_raw||0, cost_usd: r.cost_usd!=null? r.cost_usd : (r.cost_raw||0)/1e8,
          key_id:r.key_id||"", session_id:r.session_id||"", plan:r.plan||null
        }));
        // 100MB 硬盘上限：预估本批大小，超限则停止
        try{
          const estBatchBytes = JSON.stringify(dbRecs).length * 1.3;
          const curBytes = await getCurrentDbBytes();
          if(curBytes + estBatchBytes > 100*1024*1024){
            setSyncState({phase:"error", running:false, message:`已达到 100MB 上限（当前约 ${(curBytes/1024/1024).toFixed(1)}MB，预估本批 ${(estBatchBytes/1024).toFixed(1)}KB），已停止`});
            break;
          }
        }catch{}
        // 增量：检测重叠与分钟级一致性
        if(mode==="incremental" && localUsgSet.size>0){
          const existingIds = new Set(dbRecs.filter(r=> localUsgSet.has(r.usg_id)).map(r=>r.usg_id));
          if(existingIds.size>0){
            batchHasOverlap=true;
            // 取第一个重叠记录的分钟作为检测点
            const overlapRec = dbRecs.find(r=> existingIds.has(r.usg_id));
            const minute = overlapRec ? overlapRec.created_at.slice(0,16) : "";
            if(minute){
              const fetchedMinuteRecs = dbRecs.filter(r=> r.created_at.slice(0,16)===minute);
              const localSummary = minuteCache.get(minute);
              const fetchedCount = fetchedMinuteRecs.length;
              const fetchedTokenSum = fetchedMinuteRecs.reduce((s,r)=> s + (r.input_tokens||0)+(r.output_tokens||0)+(r.cache_read_tokens||0),0);
              const fetchedCost = fetchedMinuteRecs.reduce((s,r)=> s + (r.cost_raw||0),0);
              const localCount = localSummary ? localSummary.count : 0;
              const localTokenSum = localSummary ? localSummary.tokenSum : 0;
              const localCost = localSummary ? localSummary.costRaw : 0;
              const mismatch = !localSummary || localCount!==fetchedCount || localTokenSum!==fetchedTokenSum || localCost!==fetchedCost;
              if(mismatch){
                batchMismatchMinute=minute;
                batchMismatchInfo={minute, fetchedCount, localCount, fetchedTokenSum, localTokenSum, fetchedCost, localCost, existingIds: [...existingIds].slice(0,3)};
                console.warn(`[GoGauge] 分钟级不一致 ${minute} 本地${localCount}/${localTokenSum} vs 远端${fetchedCount}/${fetchedTokenSum}`);
              }
            }
          }
        }
        // 处理写入
        let toInsert = dbRecs;
        if(mode==="incremental"){
          // 增量只插入本地没有的
          toInsert = dbRecs.filter(r=> !localUsgSet.has(r.usg_id));
          // 如果本批有重叠且无不一致，说明已追到历史，可以只插入新记录后准备结束
          // 如果有不一致，则等待用户决策
          if(batchMismatchMinute){
            // 暂停并询问用户
            mismatchPendingDetails={minute: batchMismatchMinute, info: batchMismatchInfo, page: p, workspaceId};
            setSyncState({phase:"mismatch", message:`检测到 ${batchMismatchMinute} 本地与远端不一致，等待用户选择…`, progress: progBase});
            // 通知前端
            try{ chrome.runtime.sendMessage({type:"SYNC_MISMATCH", details: mismatchPendingDetails}); }catch{}
            // 也用 notification 兜底
            try{ chrome.notifications?.create({type:"basic", iconUrl:"icons/icon128.png", title:"GoGauge 检测到缓存不一致", message:`${batchMismatchMinute} 本地${batchMismatchInfo.localCount}条 vs 远端${batchMismatchInfo.fetchedCount}条，是否重建？`}); }catch{}
            const choice = await new Promise(resolve=>{
              mismatchResolver=resolve;
              // 超时 5 分钟默认按拼接处理
              setTimeout(()=>{ if(mismatchResolver){ mismatchResolver("splice"); mismatchResolver=null; } }, 300000);
            });
            mismatchPendingDetails=null;
            if(choice==="rebuild"){
              console.log("[GoGauge] 用户选择重建，全量清空");
              await clearAllRecords();
              localUsgSet.clear();
              minuteCache.clear();
              // 全量插入本批所有
              toInsert = dbRecs;
              // 后续按全量继续，不再检测
              // 为避免再次触发，清空 local set 后后续批次不会再判重叠
            }else if(choice==="splice"){
              console.log("[GoGauge] 用户选择拼接，删除该分钟起本地记录");
              try{ await deleteRecordsFromMinute(batchMismatchMinute); }catch(e){ console.warn(e); }
              // 从缓存中移除该分钟及之后的本地记录
              for(const key of [...minuteCache.keys()]){
                if(key >= batchMismatchMinute) minuteCache.delete(key);
              }
              for(const id of [...localUsgSet]){
                // 粗略：无法精确知道哪些 id 属于该分钟，重新加载更安全
              }
              // 重新加载本地集合（简化：清空后后续不再判重叠，直接插入）
              // 为了简单，拼接后清空 localUsgSet，后续直接插入
              // 实际应重新构建，但为性能先清空
              // 插入本批全部
              toInsert = dbRecs;
              // 清空后后续不再检测
              localUsgSet.clear();
              minuteCache.clear();
            }else{
              // ignore: 仅插入新记录
              // toInsert 已是新记录
            }
          }
        }
        try{
          if(toInsert.length){
            const n=await bulkPutRecords(toInsert);
            batchInserted += toInsert.length;
            totalInserted += toInsert.length;
            // 更新本地缓存
            for(const r of toInsert){
              localUsgSet.add(r.usg_id);
              const minute=r.created_at.slice(0,16);
              let e=minuteCache.get(minute);
              if(!e){ e={count:0, tokenSum:0, costRaw:0}; minuteCache.set(minute,e); }
              e.count++;
              e.tokenSum += (r.input_tokens||0)+(r.output_tokens||0)+(r.cache_read_tokens||0);
              e.costRaw += (r.cost_raw||0);
            }
          }
        }catch(e){
          console.error("bulkPut error",e);
          batchFailed++;
        }
        // 记录是否需要结束增量
        if(batchHasOverlap && !batchMismatchMinute){
          foundOverlap=true;
        }
      }
      page += FETCH_BATCH;
      let progAfter = mode==="full" ? 15 + Math.round((Math.min(page,maxPages)/maxPages)*70) : 15 + Math.min(70, Math.round((page/200)*70));
      if(mode==="full") setSyncState({inserted:totalInserted, page, totalPages: maxPages, progress: progAfter });
      else setSyncState({inserted:totalInserted, page, progress: progAfter });

      if(windowBoundaryReached){
        setSyncState({message:"已到达所选时间窗口边界，停止拉取"});
        break;
      }
      if(batchFailed && mode==="incremental"){
        setSyncState({phase:"error", running:false, message:`第 ${page-FETCH_BATCH+1} 页拉取失败，请重试`});
        return {ok:false, error:"网络请求失败", partial_inserted:totalInserted};
      }
      if(batchFullPages===0){
        consecutiveEmptyBatches++;
        if(consecutiveEmptyBatches>=1) break;
      }else{
        consecutiveEmptyBatches=0;
      }
      if(mode==="incremental" && foundOverlap){
        console.log("[GoGauge] 增量已追到历史重叠点，结束");
        break;
      }
      if(SLEEP_MS>0) await new Promise(r=>setTimeout(r, SLEEP_MS));
    }

    if(windowDays && mode==="full"){
      try{
        const pruned=await pruneOldRecords(windowDays);
        if(pruned) console.log(`[GoGauge] pruned ${pruned} old records`);
      }catch{}
    }
    setSyncState({message:"正在获取汇率…", progress:92});
    try{
      const r=await fetch("https://open.er-api.com/v6/latest/USD", {headers:{"Accept":"application/json"}});
      if(r.ok){
        const j=await r.json();
        const rate=parseFloat(j && j.rates && j.rates.CNY);
        if(rate>0) await chrome.storage.local.set({usdCny: rate, usdCnyAt: Date.now()});
      }
    }catch{}

    await chrome.storage.local.set({lastSyncAt: nowIso(), lastSyncInserted: totalInserted, deepestPageFetched});
    setSyncState({running:false, phase:"done", message: totalInserted? `同步完成，新增 ${totalInserted} 条记录` : "已是最新，无新增记录", progress:100, inserted:totalInserted});
    return {ok:true, inserted: totalInserted, deepestPageFetched };
  }catch(e){
    const msg= e instanceof AuthError ? e.message : String(e.message||e);
    setSyncState({running:false, phase:"error", message: msg});
    return {ok:false, error: msg};
  }
}

// Message handling
chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  (async()=>{
    const {type, payload} = msg || {};
    if(type==="CHECK_AUTH"){
      const a=await checkAuth();
      sendResponse({ok:true, data:a});
      return;
    }
    if(type==="GET_AUTH_STATUS"){
      const a=await checkAuth();
      const ws=await getWorkspaceIdHint();
      const quotaRaw=await chrome.storage.local.get("lastQuota");
      const lastSync=await chrome.storage.local.get(["lastSyncAt","lastSyncInserted"]);
      sendResponse({ok:true, auth:a, workspaceId:ws, quota: quotaRaw.lastQuota||null, lastSync, syncState:{...syncState}});
      return;
    }
    if(type==="START_SYNC"){
      const mode=payload && payload.mode || "incremental";
      console.log("[GoGauge] START_SYNC requested mode",mode,"by",sender.tab?"content":"extension");
      if(syncState.running){
        sendResponse({ok:false, error:"同步进行中"});
        return;
      }
      sendResponse({ok:true, accepted:true});
      runSync(mode);
      return;
    }
    if(type==="CANCEL_SYNC"){
      abortFlag=true;
      setSyncState({message:"正在取消…"});
      sendResponse({ok:true});
      return;
    }
    if(type==="GET_SYNC_STATE"){
      sendResponse({ok:true, data:{...syncState}});
      return;
    }
    if(type==="GET_QUOTA"){
      try{
        const ws=await getWorkspaceIdHint();
        const q=await fetchQuotaWithCache(ws);
        sendResponse({ok:true, data:q});
      }catch(e){ sendResponse({ok:false, error:String(e.message||e)}); }
      return;
    }
    if(type==="GET_SETTINGS"){
      const s=await getSettings();
      sendResponse({ok:true, data:s});
      return;
    }
    if(type==="SAVE_SETTINGS"){
      const s=await saveSettings(payload||{});
      sendResponse({ok:true, data:s});
      return;
    }
    if(type==="CLEAR_DATA"){
      try{
        await clearAllRecords();
        await chrome.storage.local.remove(["lastSyncAt","lastSyncInserted","lastQuota","deepestPageFetched"]);
        quotaCache=null;
        sendResponse({ok:true});
      }catch(e){ sendResponse({ok:false, error:String(e)}); }
      return;
    }
    if(type==="OPEN_DASHBOARD"){
      const url=chrome.runtime.getURL("dashboard/dashboard.html");
      chrome.tabs.create({url});
      sendResponse({ok:true});
      return;
    }
    if(type==="RESOLVE_MISMATCH"){
      const choice = payload && payload.choice ? payload.choice : payload;
      if(mismatchResolver){
        mismatchResolver(choice);
        mismatchResolver=null;
        mismatchPendingDetails=null;
      }
      sendResponse({ok:true});
      return;
    }
    if(type==="GET_MISMATCH"){
      sendResponse({ok:true, details: mismatchPendingDetails});
      return;
    }
    sendResponse({ok:false, error:"unknown type"});
  })();
  return true;
});

chrome.cookies.onChanged.addListener(async (changeInfo)=>{
  if(!changeInfo.cookie || !changeInfo.cookie.domain.includes("opencode.ai")) return;
  const a=await checkAuth();
  try{ chrome.runtime.sendMessage({type:"AUTH_CHANGED", data:a}).catch(()=>{}); }catch{}
});

chrome.runtime.onInstalled.addListener(async()=>{
  await loadQuotaCache();
  const s=await getSettings();
  console.log("[GoGauge] installed, settings",s);
});
chrome.runtime.onStartup.addListener(async()=>{
  await loadQuotaCache();
});

(async()=>{ await loadQuotaCache(); })();
