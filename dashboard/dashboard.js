import { computeTotals, computeModelStats, computeDailyStats, computeTodayTrend, listModels, getRecordsPage, getQuotaCache, countRecords } from "../src/lib/db.js";

const $=(s)=>document.querySelector(s);
const $$=(s)=>document.querySelectorAll(s);
let currentHomePeriod="today";
let currentStatsPeriod="30d";
let currentRecPage=1, currentRecModel="", currentRecPeriod="30d";
let charts={};
const COLORS={input:"#4f8ef7", output:"#22c55e", reasoning:"#a78bfa", cache:"#06b6d4", cost:"#d97706"};
let syncPoll=null;

function fmtTokens(n){
  if(n>=1e6) return (n/1e6).toFixed(2)+"M";
  if(n>=1e3) return (n/1e3).toFixed(1)+"k";
  return String(n);
}
function fmtInt(n){ return new Intl.NumberFormat().format(n); }
function fmtUSD(n){ if(!n) return "$0"; if(n>=1) return "$"+n.toFixed(2); return "$"+n.toFixed(4); }
function fmtTime(iso){ try{ return new Date(iso).toLocaleString(); }catch{ return iso; } }
function countdown(sec){
  if(sec<=0) return "已重置";
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60);
  if(h>24){ const d=Math.floor(h/24); return `${d}天后重置`; }
  if(h>0) return `${h}小时${m}分后重置`;
  return `${m}分后重置`;
}
function toast(msg, ok=true){
  const wrap=$("#toast-wrap");
  const el=document.createElement("div");
  el.className="toast";
  el.style.background= ok? "#0b1220" : "#b91c1c";
  el.style.color="#fff";
  el.textContent=msg;
  wrap.appendChild(el);
  setTimeout(()=> el.remove(), 2600);
}

async function refreshHeader(){
  const r=await chrome.runtime.sendMessage({type:"GET_AUTH_STATUS"});
  const ws=r.workspaceId;
  $("#tb-workspace").textContent= ws && ws.startsWith("wrk_")? ws.slice(0,14)+"…" : (ws||"未设置");
  const q=r.quota;
  if(q) renderQuota(q);
  else {
    const cached=await chrome.storage.local.get("lastQuota");
    if(cached.lastQuota) renderQuota(cached.lastQuota);
  }
  $("#tb-updated").textContent= q && q.updated_at? new Date(q.updated_at).toLocaleTimeString() : "—";
  const sync=r.syncState;
  renderSyncBanner(sync);
  const syncInd=$("#sync-indicator");
  if(sync && sync.running) syncInd.classList.remove("hidden"); else syncInd.classList.add("hidden");
  // top loading
  $("#top-loading").hidden= !(sync && sync.running);
  // ws display in settings
  $("#set-workspace").textContent= ws || "—";
  const cnt=await countRecords();
  $("#set-count").textContent= `${fmtInt(cnt)} 条本地记录`;
  const rateInfo=await chrome.storage.local.get(["usdCny","usdCnyAt"]);
  if(rateInfo.usdCny){
    $("#set-rate").textContent=`1 USD ≈ ¥${rateInfo.usdCny.toFixed(4)}`;
    $("#set-rate-at").textContent= rateInfo.usdCnyAt? new Date(rateInfo.usdCnyAt).toLocaleString() : "";
  }else{
    $("#set-rate").textContent="—";
  }
}
function renderQuota(q){
  const box=$("#quota-blocks");
  if(!q || !q.success){
    if(!q) box.innerHTML=`<div class="qw">暂无配额数据 — 点击「开始统计」后自动获取</div>`;
    else box.innerHTML=`<div class="qw">获取失败：${(q.error||"").slice(0,120)}</div>`;
    return;
  }
  const cls=["f1","f2","f3"];
  box.innerHTML= q.windows.map((w,i)=>`
    <div class="qw">
      <div class="qw-head"><span class="qw-label">${w.label}</span><span class="qw-pct">${w.used.toFixed(1)}% 已用</span></div>
      <div class="qw-track"><div class="qw-fill ${cls[i%3]}" style="width:${Math.min(100,w.used)}%"></div></div>
      <div class="qw-meta"><span>剩余 ${w.remaining.toFixed(1)}%</span><span>${countdown(w.reset_in_sec)}</span></div>
      <div class="hint" style="margin-top:6px">重置于 ${fmtTime(w.reset_at)}</div>
    </div>`).join("");
}
function renderSyncBanner(st){
  const wrap=$("#sync-banner");
  if(!st || !st.running){
    wrap.hidden=true; return;
  }
  wrap.hidden=false;
  $("#sync-banner-msg").textContent= st.message || "同步中…";
  const pct=Math.max(0, Math.min(100, st.progress||0));
  $("#sync-banner-pct").textContent=pct+"%";
  $("#sync-banner-fill").style.width=pct+"%";
  $("#sync-banner-detail").textContent= st.page!=null? `第 ${st.page+1} 页 · 已拉取 ${st.inserted||0} 条` : `已拉取 ${st.inserted||0} 条`;
}

async function renderHome(){
  const totals=await computeTotals(currentHomePeriod);
  const grid=$("#overview-grid");
  const totalTokens= totals.uncached_input_tokens + totals.total_output_tokens + totals.total_reasoning_tokens;
  const usdCny=(await chrome.storage.local.get("usdCny")).usdCny || 7.2;
  const cny=totals.total_cost_usd*usdCny;
  if(!totals.request_count){
    grid.innerHTML=`<div class="hint" style="grid-column:1/-1">暂无数据 — 点击「开始统计」后在此查看概览</div>`;
  } else {
    grid.innerHTML=[
      {l:"缓存命中率", v: totals.hit_rate.toFixed(1)+"%", s:`命中 ${fmtTokens(totals.cache_hit_tokens)} · 未命中 ${fmtTokens(totals.uncached_input_tokens)}`},
      {l:"缓存命中量", v: fmtTokens(totals.cache_hit_tokens), s:`占输入 ${totals.hit_rate.toFixed(1)}%`},
      {l:"总 TOKEN", v: fmtTokens(totalTokens), s:"含缓存命中"},
      {l:"请求数", v: fmtInt(totals.request_count), s:`会话 ${fmtInt(totals.session_count)}`},
      {l:"费用", v: fmtUSD(totals.total_cost_usd), s:`≈ ¥${cny.toFixed(2)}`},
      {l:"缓存写入", v: fmtTokens(totals.cache_write_tokens), s:"新写入缓存"},
    ].map(k=>`<div class="kpi"><div class="kpi-label">${k.l}</div><div class="kpi-value">${k.v}</div><div class="kpi-sub">${k.s}</div></div>`).join("");
  }
  const detail=$("#cache-detail");
  if(totals.request_count){
    detail.innerHTML=`<b>缓存命中率</b> = 命中 / (命中+未命中) = ${fmtTokens(totals.cache_hit_tokens)} / (${fmtTokens(totals.cache_hit_tokens)}+${fmtTokens(totals.uncached_input_tokens)}) = <b>${totals.hit_rate.toFixed(2)}%</b> · 总输入(含缓存) ${fmtTokens(totals.total_input_tokens)} · 输出 ${fmtTokens(totals.total_output_tokens)} · 推理 ${fmtTokens(totals.total_reasoning_tokens)}`;
    detail.hidden=false;
  } else detail.hidden=true;

  // today trend
  const trend=await computeTodayTrend();
  renderTodayChart(trend);
  const daily=await computeDailyStats(30);
  renderDailyChart(daily);
}

let todayChart=null, dailyChart=null;
function setChartEmpty(canvasId, empty, msg){
  const canvas=document.getElementById(canvasId);
  if(!canvas) return;
  let ph=document.getElementById(canvasId+"-ph");
  if(empty){
    canvas.style.display="none";
    if(!ph){
      ph=document.createElement("div");
      ph.id=canvasId+"-ph";
      ph.className="chart-empty";
      canvas.parentElement.appendChild(ph);
    }
    ph.textContent=msg||"暂无数据 — 点击右上角『开始统计』后查看";
    ph.style.display="flex";
    return true;
  }else{
    canvas.style.display="";
    if(ph) ph.style.display="none";
    return false;
  }
}
function renderTodayChart(buckets){
  const ctx=document.getElementById("today-chart");
  if(!ctx) return;
  const isEmpty = !buckets || buckets.every(b=> (b.input||0)===0 && (b.output||0)===0 && (b.count||0)===0);
  if(setChartEmpty("today-chart", isEmpty)) { if(todayChart){ try{todayChart.destroy();}catch(e){} todayChart=null; } return; }
  if(todayChart) todayChart.destroy();
  todayChart=new Chart(ctx, {
    type:"bar",
    data:{
      labels: buckets.map(b=> b.label),
      datasets:[
        {label:"输入", data: buckets.map(b=> b.input), backgroundColor: COLORS.input},
        {label:"输出", data: buckets.map(b=> b.output), backgroundColor: COLORS.output},
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{legend:{position:"top"}},
      scales:{x:{stacked:false}, y:{beginAtZero:true}}
    }
  });
}
function renderDailyChart(rows){
  const ctx=document.getElementById("daily-chart");
  if(!ctx) return;
  const isEmpty = !rows || rows.length===0 || rows.every(r=> (r.uncached_input_tokens||0)===0 && (r.total_output_tokens||0)===0);
  if(setChartEmpty("daily-chart", isEmpty)) { if(dailyChart){ try{dailyChart.destroy();}catch(e){} dailyChart=null; } return; }
  if(dailyChart) dailyChart.destroy();
  dailyChart=new Chart(ctx, {
    type:"line",
    data:{
      labels: rows.map(r=> r.date.slice(5)),
      datasets:[
        {label:"输入", data: rows.map(r=> r.uncached_input_tokens), borderColor: COLORS.input, backgroundColor: COLORS.input+"22", tension:.3},
        {label:"输出", data: rows.map(r=> r.total_output_tokens), borderColor: COLORS.output, backgroundColor: COLORS.output+"22", tension:.3},
        {label:"费用", data: rows.map(r=> r.total_cost_usd), borderColor: COLORS.cost, backgroundColor: COLORS.cost+"22", yAxisID:"y1", tension:.3},
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{mode:"index", intersect:false},
      plugins:{legend:{position:"top"}},
      scales:{y:{beginAtZero:true}, y1:{position:"right", grid:{display:false}, beginAtZero:true}}
    }
  });
}

// stats page
let modelChart=null, trendChart=null;
async function renderStats(){
  const totals=await computeTotals(currentStatsPeriod);
  const compose=$("#compose-grid");
  if(!totals.request_count){
    compose.innerHTML=`<div class="hint" style="grid-column:1/-1">暂无数据</div>`;
  } else {
    compose.innerHTML=[
      {l:"输入 (未命中)", v: fmtTokens(totals.uncached_input_tokens), s:`含缓存 ${fmtTokens(totals.total_input_tokens)}`},
      {l:"输出", v: fmtTokens(totals.total_output_tokens), s:`${totals.request_count} 次请求`},
      {l:"推理", v: fmtTokens(totals.total_reasoning_tokens), s:"reasoning"},
      {l:"缓存读", v: fmtTokens(totals.cache_hit_tokens), s:`命中率 ${totals.hit_rate.toFixed(1)}%`},
      {l:"缓存写", v: fmtTokens(totals.cache_write_tokens), s:"新写入"},
      {l:"费用", v: fmtUSD(totals.total_cost_usd), s:`会话 ${totals.session_count}`},
    ].map(k=>`<div class="kpi"><div class="kpi-label">${k.l}</div><div class="kpi-value">${k.v}</div><div class="kpi-sub">${k.s}</div></div>`).join("");
  }
  const models=await computeModelStats(currentStatsPeriod);
  renderModelChart(models);
  renderModelRank(models);
  const daily=await computeDailyStats(30);
  renderTrendChart(daily, document.querySelector(`#page-stats [data-dim].active`)?.dataset.dim || "input");
}
function renderModelChart(models){
  const ctx=document.getElementById("model-chart");
  if(!ctx) return;
  const isEmpty = !models || models.length===0;
  if(setChartEmpty("model-chart", isEmpty, "暂无模型数据")){ if(modelChart){ try{modelChart.destroy();}catch(e){} modelChart=null; } return; }
  if(modelChart) modelChart.destroy();
  const top=models.slice(0,8);
  const sum=top.reduce((a,b)=> a+b.uncached_input_tokens+b.cache_hit_tokens, 0);
  modelChart=new Chart(ctx, {
    type:"doughnut",
    data:{
      labels: top.map(m=> m.model),
      datasets:[{data: top.map(m=> m.uncached_input_tokens+m.cache_hit_tokens), backgroundColor: ["#4f8ef7","#22c55e","#06b6d4","#a78bfa","#f59e0b","#ec4899","#14b8a6","#f97316"]}]
    },
    options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{position:"bottom"}}}
  });
}
function renderModelRank(models){
  const el=$("#model-rank");
  if(!models.length){ el.innerHTML=`<div class="hint">暂无数据</div>`; return; }
  const max=Math.max(...models.map(m=> m.uncached_input_tokens+m.cache_hit_tokens),1);
  el.innerHTML= models.slice(0,12).map(m=>{
    const tot=m.uncached_input_tokens+m.cache_hit_tokens;
    const pct=(tot/max*100).toFixed(0);
    return `<div class="rank-item">
      <div class="rank-left"><span class="rank-name">${m.model}</span><span class="rank-sub">${fmtInt(m.request_count)} 次 · 命中率 ${m.hit_rate}% · ${fmtUSD(m.total_cost_usd)}</span></div>
      <span class="rank-val">${fmtTokens(tot)}</span>
      <div class="rank-bar"><div class="rank-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join("");
}
function renderTrendChart(daily, dim){
  const isEmpty = !daily || daily.length===0;
  if(setChartEmpty("trend-chart", isEmpty)){ if(trendChart){ try{trendChart.destroy();}catch(e){} trendChart=null; } return; }
  const ctx=document.getElementById("trend-chart");
  if(!ctx) return;
  if(trendChart) trendChart.destroy();
  const getVal=(r)=> dim==="input"? r.uncached_input_tokens : dim==="output"? r.total_output_tokens : r.total_cost_usd;
  const color= dim==="input"? COLORS.input : dim==="output"? COLORS.output : COLORS.cost;
  trendChart=new Chart(ctx, {
    type:"line",
    data:{
      labels: daily.map(r=> r.date.slice(5)),
      datasets:[{label: dim==="cost"? "费用 (USD)" : dim==="input"? "输入" : "输出", data: daily.map(getVal), borderColor: color, backgroundColor: color+"22", fill:true, tension:.35}]
    },
    options:{responsive:true, maintainAspectRatio:false, scales:{y:{beginAtZero:true}}}
  });
}

// records
async function renderRecords(){
  // populate model filter options once
  const models=await listModels();
  const sel=$("#rec-model-filter");
  const cur=sel.value;
  if(sel.options.length<=1){
    for(const m of models){ const o=document.createElement("option"); o.value=m; o.textContent=m; sel.appendChild(o); }
    sel.value=cur;
  }
  const data=await getRecordsPage(currentRecPage, 20, currentRecPeriod, currentRecModel);
  const body=$("#records-body");
  if(!data.items.length){
    body.innerHTML=`<tr><td colspan="8" style="text-align:center;color:var(--muted)">暂无记录 — 请先「开始统计」</td></tr>`;
  } else {
    body.innerHTML= data.items.map(r=>`
      <tr>
        <td>${fmtTime(r.created_at)}</td>
        <td>${r.model||"—"}</td>
        <td class="num">${fmtTokens(r.input_tokens)}</td>
        <td class="num">${fmtTokens(r.output_tokens)}</td>
        <td class="num">${fmtTokens(r.reasoning_tokens)}</td>
        <td class="num">${fmtTokens(r.cache_read_tokens)}</td>
        <td class="num">${fmtUSD(r.cost_usd)}</td>
        <td title="${r.session_id}">${(r.session_id||"—").slice(0,12)}</td>
      </tr>`).join("");
  }
  const pager=$("#records-pager");
  pager.innerHTML=`<span class="hint">共 ${fmtInt(data.total)} 条 · 第 ${data.page}/${data.totalPages} 页</span>
    <span><button id="rec-prev" ${data.page<=1?"disabled":""}>上一页</button> <button id="rec-next" ${data.page>=data.totalPages?"disabled":""}>下一页</button></span>`;
  $("#rec-prev")?.addEventListener("click", ()=>{ if(currentRecPage>1){ currentRecPage--; renderRecords(); }});
  $("#rec-next")?.addEventListener("click", ()=>{ currentRecPage++; renderRecords(); });
}

// navigation
function showPage(id){
  $$(".page").forEach(p=> p.hidden=true);
  const el=document.getElementById("page-"+id);
  if(el) el.hidden=false;
  $$(".side-item").forEach(b=> b.classList.toggle("active", b.dataset.page===id));
  if(id==="home") renderHome();
  if(id==="stats") renderStats();
  if(id==="records") renderRecords();
}
$$(".side-item").forEach(btn=> btn.addEventListener("click", ()=> showPage(btn.dataset.page)));

// pills
$("#home-pills").addEventListener("click", (e)=>{
  const b=e.target.closest("[data-r]"); if(!b) return;
  $$("#home-pills .pill").forEach(x=>x.classList.remove("active"));
  b.classList.add("active");
  currentHomePeriod=b.dataset.r;
  renderHome();
});
$("#stats-pills").addEventListener("click", (e)=>{
  const b=e.target.closest("[data-r]"); if(!b) return;
  $$("#stats-pills .pill").forEach(x=>x.classList.remove("active"));
  b.classList.add("active");
  currentStatsPeriod=b.dataset.r;
  renderStats();
});
$$("#page-stats [data-dim]").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    $$("#page-stats [data-dim]").forEach(x=>x.classList.remove("active"));
    btn.classList.add("active");
    computeDailyStats(30).then(d=> renderTrendChart(d, btn.dataset.dim));
  });
});
$("#rec-model-filter").addEventListener("change", (e)=>{ currentRecModel=e.target.value; currentRecPage=1; renderRecords(); });
$("#rec-period").addEventListener("change", (e)=>{ currentRecPeriod=e.target.value; currentRecPage=1; renderRecords(); });

// theme — 跟随系统 (auto) + 亮/暗 手动覆盖
let currentStoredTheme = "auto";
const _mediaDark = window.matchMedia("(prefers-color-scheme: dark)");
function resolveTheme(stored){
  if(stored==="light" || stored==="dark") return stored;
  return _mediaDark.matches ? "dark" : "light";
}
async function applyTheme(t){
  let stored = t || "auto";
  if(stored!=="auto" && stored!=="light" && stored!=="dark") stored="auto";
  currentStoredTheme = stored;
  let resolved = resolveTheme(stored);
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.setAttribute("data-theme-choice", stored);
  let btn=document.getElementById("btn-theme");
  if(btn){
    if(stored==="auto") btn.textContent = resolved==="dark" ? "◐ 自动·暗" : "◐ 自动·亮";
    else btn.textContent = stored==="dark" ? "☀ 亮色" : "◐ 暗色";
    btn.title = stored==="auto" ? "跟随系统，点击切换" : "当前"+(stored==="dark"?"暗色":"亮色")+", 点击切换";
  }
  document.querySelectorAll("#set-theme-pills .pill").forEach(b=>{
    b.classList.toggle("active", b.dataset.v===stored);
  });
  await chrome.storage.local.set({theme: stored});
}
_mediaDark.addEventListener("change", ()=>{
  if(currentStoredTheme==="auto"){
    document.documentElement.setAttribute("data-theme", _mediaDark.matches?"dark":"light");
    let btn=document.getElementById("btn-theme");
    if(btn) btn.textContent = _mediaDark.matches ? "◐ 自动·暗" : "◐ 自动·亮";
  }
});
document.getElementById("btn-theme")?.addEventListener("click", async()=>{
  let next;
  if(currentStoredTheme==="auto") next = resolveTheme("auto")==="dark" ? "light" : "dark";
  else if(currentStoredTheme==="light") next="dark";
  else if(currentStoredTheme==="dark") next="auto";
  else next="auto";
  await applyTheme(next);
});
document.getElementById("set-theme-pills")?.addEventListener("click", async(e)=>{
  const b=e.target.closest("[data-v]"); if(!b) return;
  await applyTheme(b.dataset.v);
});
(async()=>{
  const s=await chrome.storage.local.get("theme");
  let initial = s.theme || "auto";
  if(initial!=="auto" && initial!=="light" && initial!=="dark") initial="auto";
  await applyTheme(initial);
})();

// sync buttons
async function startSync(mode){
  try{
    const r=await chrome.runtime.sendMessage({type:"START_SYNC", payload:{mode}});
    if(!r || !r.ok) { toast(r && r.error || "启动失败", false); return; }
    toast(mode==="full"? "全量同步已开始…":"增量同步已开始…");
    startPolling();
  }catch(e){ toast(String(e.message||e), false); }
}
$("#btn-sync").addEventListener("click", ()=> startSync("incremental"));
$("#btn-sync-full")?.addEventListener("click", async()=>{
  if(!confirm("全量同步最多拉取 2000 页（约10万条），耗时较长，确定继续？")) return;
  startSync("full");
});
$("#btn-start-incr").addEventListener("click", ()=> startSync("incremental"));
$("#btn-start-full").addEventListener("click", async()=>{
  if(!confirm("全量同步最多拉取 2000 页，耗时较长，确定继续？")) return;
  startSync("full");
});
$("#btn-clear").addEventListener("click", async()=>{
  if(!confirm("确定清空所有本地用量记录？此操作不可恢复。")) return;
  const r=await chrome.runtime.sendMessage({type:"CLEAR_DATA"});
  if(r && r.ok){ toast("已清空"); renderHome(); renderRecords(); refreshHeader(); }
  else toast("清空失败", false);
});
$("#btn-go-opencode").addEventListener("click", ()=> chrome.tabs.create({url:"https://opencode.ai"}));
$("#set-window-pills").addEventListener("click", async(e)=>{
  const b=e.target.closest("[data-v]"); if(!b) return;
  $$("#set-window-pills .pill").forEach(x=> x.classList.remove("active"));
  b.classList.add("active");
  const v=parseInt(b.dataset.v,10);
  await chrome.runtime.sendMessage({type:"SAVE_SETTINGS", payload:{windowDays: v||null}});
  toast(`同步范围已设为 ${v? v+" 天" : "全部"}`);
});
const turboChk=document.getElementById("set-turbo");
if(turboChk){
  turboChk.addEventListener("change", async(e)=>{
    const on=e.target.checked;
    await chrome.runtime.sendMessage({type:"SAVE_SETTINGS", payload:{turbo:on}});
    toast(on? "已开启极速同步：并发 10 / 无间隔":"已关闭极速同步：恢复保守模式");
  });
}

function startPolling(){
  if(syncPoll) clearInterval(syncPoll);
  syncPoll=setInterval(async()=>{
    try{
      const r=await chrome.runtime.sendMessage({type:"GET_SYNC_STATE"});
      renderSyncBanner(r.data);
      $("#top-loading").hidden= !(r.data && r.data.running);
      $("#sync-indicator").classList.toggle("hidden", !(r.data && r.data.running));
      if(r.data && !r.data.running){
        clearInterval(syncPoll); syncPoll=null;
        refreshHeader();
        // re-render current page
        const activeSide=document.querySelector(".side-item.active");
        const page=activeSide? activeSide.dataset.page : "home";
        if(page==="home") renderHome();
        if(page==="stats") renderStats();
        if(page==="records") renderRecords();
        if(r.data.phase==="done") toast(r.data.message || "同步完成");
        else if(r.data.phase==="error") toast(r.data.message || "同步失败", false);
      }
    }catch{}
  }, 800);
}

chrome.runtime.onMessage.addListener((msg)=>{
  if(msg.type==="SYNC_STATE"){
    renderSyncBanner(msg.state);
    $("#top-loading").hidden= !(msg.state && msg.state.running);
  }
  if(msg.type==="AUTH_CHANGED") refreshHeader();
});

// init settings pills
(async()=>{
  const s=await chrome.runtime.sendMessage({type:"GET_SETTINGS"});
  const wd=s.data.windowDays;
  const v= wd==null? 0 : wd;
  $("#set-window-pills .pill").forEach(b=> b.classList.toggle("active", parseInt(b.dataset.v,10)===v));
  const turboEl=document.getElementById("set-turbo"); if(turboEl) turboEl.checked = !!s.data.turbo;
})();

refreshHeader();
renderHome();
