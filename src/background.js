// Background service worker — single source of truth for sync & cookie auth
// NOTE: Must NOT use dynamic import() in ServiceWorker scope (banned per HTML spec).
// All imports are static at top level.
import { fetchQuota, fetchUsagePage, fetchKeyNames, resolveWorkspaceId, AuthError } from "./lib/api.js";
import { bulkPutRecords, pruneOldRecords, clearAllRecords } from "./lib/db.js";

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

// Main sync — only starts on user click (mandatory)
async function runSync(mode="incremental"){
  if(syncState.running) return {ok:false, error:"同步进行中"};
  abortFlag=false;
  const settings=await getSettings();
  const windowDays= settings.windowDays ?? 90; // null means all
  const isTurbo = !!settings.turbo;
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
    setSyncState({phase:"usage", message:`正在拉取用量记录 ${isTurbo?"(极速×10)":""} (工作区 ${workspaceId.slice(0,10)}…)`, progress:14});
    let keyNames={};
    try{ keyNames=await fetchKeyNames(workspaceId); if(Object.keys(keyNames).length) await chrome.storage.local.set({keyNames}); }catch{}

    const MAX_FULL_PAGES=2000;
    const INCREMENTAL_PAGES=isTurbo ? 10 : 5;
    const FETCH_BATCH=isTurbo ? 10 : 5;
    const SLEEP_MS=isTurbo ? 0 : 120;
    const maxPages = mode==="full" ? MAX_FULL_PAGES : INCREMENTAL_PAGES;
    let page=0;
    let totalInserted=0;
    let deepestPageFetched=-1;
    let windowBoundaryReached=false;
    let consecutiveEmptyBatches=0;

    while(page < maxPages){
      if(abortFlag){
        setSyncState({phase:"error", running:false, message:"已取消"});
        return {ok:false, error:"已取消", partialInserted:totalInserted, canceled:true};
      }
      const batchPages=[...Array(Math.min(FETCH_BATCH, maxPages-page))].map((_,i)=> page+i);
      setSyncState({page, message:`正在拉取第 ${page+1}–${page+batchPages.length} 页…`, progress: 15 + Math.round((page/maxPages)*70) });
      const batchMap=await fetchUsageBatch(workspaceId, batchPages);
      let batchInserted=0;
      let batchFullPages=0;
      let batchFailed=0;
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
        try{
          const n=await bulkPutRecords(dbRecs);
          batchInserted += dbRecs.length;
          totalInserted += dbRecs.length;
        }catch(e){
          console.error("bulkPut error",e);
          batchFailed++;
        }
      }
      page += FETCH_BATCH;
      setSyncState({inserted:totalInserted, page, progress: 15 + Math.round((Math.min(page,maxPages)/maxPages)*70) });

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
      if(mode==="incremental" && batchInserted===0){
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
