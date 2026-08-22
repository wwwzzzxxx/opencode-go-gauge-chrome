import { computeTotals } from "../src/lib/db.js";

// theme — 跟随系统
(async()=>{
  try{
    const s=await chrome.storage.local.get("theme");
    let stored=s.theme || "auto";
    let resolved = (stored==="light"||stored==="dark") ? stored : (window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
    document.documentElement.setAttribute("data-theme", resolved);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", e=>{
      chrome.storage.local.get("theme").then(s2=>{
        let st=s2.theme||"auto";
        if(st==="auto"){
          document.documentElement.setAttribute("data-theme", e.matches?"dark":"light");
        }
      });
    });
  }catch{}
})();

const $ = (s)=> document.querySelector(s);
let currentPeriod="30d";
let syncPoll=null;

function fmtTokens(n){
  if(n>=1e6) return (n/1e6).toFixed(2)+"M";
  if(n>=1e3) return (n/1e3).toFixed(1)+"k";
  return String(n);
}
function fmtUSD(n){
  if(!n) return "$0";
  if(n>=1) return "$"+n.toFixed(2);
  return "$"+n.toFixed(4);
}
function fmtTime(iso){
  try{ const d=new Date(iso); return d.toLocaleString(); }catch{ return iso }
}
function countdown(sec){
  if(sec<=0) return "已重置";
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60);
  if(h>24){ const d=Math.floor(h/24); return `${d}天后`; }
  if(h>0) return `${h}小时${m}分后`;
  return `${m}分后`;
}
async function refreshAuth(){
  const resp=await chrome.runtime.sendMessage({type:"GET_AUTH_STATUS"});
  const auth=resp.auth;
  const ws=resp.workspaceId;
  const banner=$("#auth-banner"), ok=$("#auth-ok");
  if(auth && auth.loggedIn){
    banner.hidden=true; ok.hidden=false;
    $("#auth-ok-text").textContent="已登录 opencode.ai";
    $("#workspace-chip").textContent= ws && ws.startsWith("wrk_")? ws.slice(0,12)+"…" : (ws||"Default");
    $("#btn-start").disabled=false;
    $("#btn-full").disabled=false;
  }else{
    banner.hidden=false; ok.hidden=true;
    $("#auth-text").textContent= auth.error? "检查失败："+auth.error : "未登录 — 请先登录 opencode.ai";
    $("#workspace-chip").textContent="—";
    $("#btn-start").disabled=false; // allow click but will show error
  }
  // quota
  const q=resp.quota;
  renderQuota(q);
  // sync state
  renderSyncState(resp.syncState || resp.lastSync);
  // totals grid
  renderTotals(currentPeriod);
  const lastSyncAt= (await chrome.storage.local.get(["lastSyncAt", "lastSyncInserted"]));
  if(lastSyncAt.lastSyncAt){
    $("#last-sync").textContent=`上次同步：${fmtTime(lastSyncAt.lastSyncAt)} · 新增 ${lastSyncAt.lastSyncInserted||0} 条`;
  }else{
    $("#last-sync").textContent="尚未同步 — 点击上方「开始统计」拉取数据";
  }
}
function renderQuota(q){
  const box=$("#quota-box");
  const upd=$("#quota-updated");
  if(!q){
    box.innerHTML=`<div class="skeleton">尚无配额数据，点击「开始统计」后自动获取</div>`;
    upd.textContent="—";
    return;
  }
  if(!q.success){
    box.innerHTML=`<div class="skeleton">获取失败：${(q.error||"未知错误").slice(0,80)}</div>`;
    upd.textContent= q.updated_at? fmtTime(q.updated_at) : "—";
    return;
  }
  upd.textContent= q.updated_at? fmtTime(q.updated_at) : "—";
  const colors=["c1","c2","c3"];
  box.innerHTML= q.windows.map((w,i)=>`
    <div class="qw">
      <div class="qw-head"><span class="qw-label">${w.label}</span><span class="qw-pct">${w.used.toFixed(1)}% 已用</span></div>
      <div class="qw-track"><div class="qw-fill ${colors[i%3]}" style="width:${Math.min(100,w.used)}%"></div></div>
      <div class="qw-meta"><span>剩余 ${w.remaining.toFixed(1)}%</span><span>${countdown(w.reset_in_sec)}</span></div>
    </div>`).join("");
}
function renderSyncState(st){
  const wrap=$("#progress-wrap");
  const pollState= st && st.running!==undefined? st : null;
  let active=null;
  if(pollState && pollState.running){
    active=pollState;
  }
  if(!active){
    wrap.hidden=true;
    return;
  }
  wrap.hidden=false;
  $("#progress-msg").textContent= active.message || (active.phase==="quota"? "获取配额中…":"同步中…");
  const pct= Math.max(0, Math.min(100, active.progress||0));
  $("#progress-pct").textContent=pct+"%";
  $("#progress-fill").style.width=pct+"%";
  const totalPart2 = active.totalPages ? ` / 共 ${active.totalPages} 页` : "";
  $("#progress-detail").textContent= active.page? `第 ${active.page+1}${totalPart2} · 已拉取 ${active.inserted||0} 条` : `已拉取 ${active.inserted||0} 条` + totalPart2;
}

async function renderTotals(period){
  const totals=await computeTotals(period).catch(()=>null);
  const grid=$("#totals-grid");
  if(!totals || !totals.request_count){
    grid.innerHTML=`<div class="skeleton" style="grid-column:1/-1">暂无数据 — 统计后在此查看概览</div>`;
    $("#cache-bar").hidden=true;
    return;
  }
  const totalTokens= totals.uncached_input_tokens + totals.total_output_tokens + totals.total_reasoning_tokens;
  const usdCny= (await chrome.storage.local.get("usdCny")).usdCny || 7.2;
  const cny= totals.total_cost_usd * usdCny;
  const items=[
    {l:"缓存命中率", v: totals.hit_rate.toFixed(1)+"%", s:`命中 ${fmtTokens(totals.cache_hit_tokens)} · 未命中 ${fmtTokens(totals.uncached_input_tokens)}`, hl:true},
    {l:"缓存命中量", v: fmtTokens(totals.cache_hit_tokens), s:`占输入 ${totals.hit_rate.toFixed(1)}%`},
    {l:"总 TOKEN", v: fmtTokens(totalTokens), s:"含缓存命中"},
    {l:"请求数", v: String(totals.request_count), s:`会话 ${totals.session_count}`},
    {l:"费用", v: fmtUSD(totals.total_cost_usd), s:`≈ ¥${cny.toFixed(2)}`},
    {l:"输入 (未命中)", v: fmtTokens(totals.uncached_input_tokens), s:`输出 ${fmtTokens(totals.total_output_tokens)}`},
  ];
  grid.innerHTML= items.map((k,i)=>`
    <div class="kpi ${k.hl? "hl": (i===1?"hl2":"")}">
      <div class="kpi-label">${k.l}</div>
      <div class="kpi-value">${k.v}</div>
      <div class="kpi-sub">${k.s}</div>
    </div>`).join("");
  const bar=$("#cache-bar");
  bar.hidden=false;
  $("#cache-bar-fill").style.width= Math.min(100, totals.hit_rate)+"%";
  $("#cache-bar-text").textContent=`缓存命中率 ${totals.hit_rate.toFixed(1)}% · 命中 ${fmtTokens(totals.cache_hit_tokens)} / 未命中 ${fmtTokens(totals.uncached_input_tokens)}`;
}

// events
document.querySelectorAll(".pill-row .pill").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    document.querySelectorAll(`.pill[data-period]`).forEach(b=> b.classList.remove("active"));
    btn.classList.add("active");
    currentPeriod=btn.dataset.period;
    renderTotals(currentPeriod);
  });
});
$("#btn-start").addEventListener("click", async()=>{
  $("#btn-start").disabled=true;
  try{
    const resp=await chrome.runtime.sendMessage({type:"START_SYNC", payload:{mode:"incremental"}});
    if(!resp || !resp.ok){
      alert(resp && resp.error || "启动失败");
      $("#btn-start").disabled=false;
      return;
    }
    startPolling();
  }catch(e){
    alert("启动失败: "+e.message);
    $("#btn-start").disabled=false;
  }
});
$("#btn-full").addEventListener("click", async()=>{
  if(!confirm("全量同步将拉取最多 2000 页（约 10万条）记录，耗时较长且流量较大，确定继续？")) return;
  $("#btn-full").disabled=true;
  try{
    const resp=await chrome.runtime.sendMessage({type:"START_SYNC", payload:{mode:"full"}});
    if(!resp || !resp.ok) alert(resp && resp.error || "启动失败");
    else startPolling();
  }catch(e){ alert(e.message); }
  $("#btn-full").disabled=false;
});
$("#btn-cancel").addEventListener("click", ()=>{
  chrome.runtime.sendMessage({type:"CANCEL_SYNC"});
});
$("#btn-go-login").addEventListener("click", ()=>{
  chrome.tabs.create({url:"https://opencode.ai/login"});
});
$("#btn-dashboard").addEventListener("click", ()=> chrome.runtime.sendMessage({type:"OPEN_DASHBOARD"}));
$("#btn-open-dash").addEventListener("click", ()=> chrome.runtime.sendMessage({type:"OPEN_DASHBOARD"}));

function startPolling(){
  if(syncPoll) clearInterval(syncPoll);
  syncPoll=setInterval(async()=>{
    try{
      const r=await chrome.runtime.sendMessage({type:"GET_SYNC_STATE"});
      renderSyncState(r.data);
      if(!r.data.running){
        clearInterval(syncPoll); syncPoll=null;
        $("#btn-start").disabled=false;
        $("#btn-full").disabled=false;
        refreshAuth();
      }
    }catch{}
  }, 700);
}

function showMismatch(details){
  const banner=document.getElementById("mismatch-banner");
  const text=document.getElementById("mismatch-text");
  if(!banner || !text) return;
  const d=details || {};
  if(d.count && d.list){
    text.textContent=`${d.count}个分钟不一致：` + d.list.slice(0,3).map(m=> `${m.minute}(${m.info.localCount}→${m.info.fetchedCount})`).join("，") + (d.count>3?` 等共${d.count}个`:"");
  } else {
    const info=d.info || {};
    const minute=d.minute || "未知分钟";
    text.textContent=`${minute} 本地${info.localCount||"-"}条 vs 远端${info.fetchedCount||"-"}条`;
  }
  banner.hidden=false;
}
function hideMismatch(){ const b=document.getElementById("mismatch-banner"); if(b) b.hidden=true; }
async function resolveMismatch(choice){ hideMismatch(); try{ await chrome.runtime.sendMessage({type:"RESOLVE_MISMATCH", payload:{choice}});}catch{} }

document.getElementById("mismatch-rebuild")?.addEventListener("click", ()=> resolveMismatch("rebuild"));
document.getElementById("mismatch-splice")?.addEventListener("click", ()=> resolveMismatch("splice"));
document.getElementById("mismatch-ignore")?.addEventListener("click", ()=> resolveMismatch("ignore"));

chrome.runtime.onMessage.addListener((msg)=>{
  if(msg.type==="SYNC_MISMATCH"){ showMismatch(msg.details || msg); }
  if(msg.type==="SYNC_STATE"){
    renderSyncState(msg.state);
    if(msg.state && msg.state.phase==="mismatch"){
      chrome.runtime.sendMessage({type:"GET_MISMATCH"}).then(r=>{ if(r && r.details) showMismatch(r.details); }).catch(()=>{});
    }
  }
  if(msg.type==="AUTH_CHANGED") refreshAuth();
});
chrome.storage.onChanged.addListener((changes, area)=>{
  if(area!=="local" || !changes.syncState) return;
  const ns=changes.syncState.newValue;
  renderSyncState(ns);
  if(ns && !ns.running && typeof syncPoll!=="undefined" && syncPoll){
    clearInterval(syncPoll); syncPoll=null;
    document.getElementById("btn-start") && (document.getElementById("btn-start").disabled=false);
    document.getElementById("btn-full") && (document.getElementById("btn-full").disabled=false);
    refreshAuth();
  }
});
// 启动时检查是否有待处理的不一致
chrome.runtime.sendMessage({type:"GET_MISMATCH"}).then(r=>{ if(r && r.details) showMismatch(r.details); }).catch(()=>{});

refreshAuth();
