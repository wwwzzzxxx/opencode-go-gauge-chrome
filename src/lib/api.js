// OpenCode Go API — JS port of opencode_api.py
// Handles quota (HTML regex) + usage (/_server server-fn)
export const DASHBOARD_BASE = "https://opencode.ai/workspace";
export const WORKSPACE_SERVER_ID = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
export const DEFAULT_USAGE_SERVER_ID = "bfd684bfc2e4eed05cd0b518f5e4eafd3f3376e3938abb9e536e7c03df831e5c";
export const LABEL_ROLLING = "5h Rolling";
export const LABEL_WEEKLY = "Weekly";
export const LABEL_MONTHLY = "Monthly";

// Regex — port of Python
const R_ROLLING_PCT_FIRST = /rollingUsage:\s*\$R\[\d+\]\s*=\s*\{[^}]*usagePercent\s*:\s*(-?\d+(?:\.\d+)?)[^}]*resetInSec\s*:\s*(-?\d+(?:\.\d+)?)[^}]*\}/;
const R_ROLLING_RESET_FIRST = /rollingUsage:\s*\$R\[\d+\]\s*=\s*\{[^}]*resetInSec\s*:\s*(-?\d+(?:\.\d+)?)[^}]*usagePercent\s*:\s*(-?\d+(?:\.\d+)?)[^}]*\}/;
const R_WEEKLY_PCT_FIRST = /weeklyUsage:\s*\$R\[\d+\]\s*=\s*\{[^}]*usagePercent\s*:\s*(-?\d+(?:\.\d+)?)[^}]*resetInSec\s*:\s*(-?\d+(?:\.\d+)?)[^}]*\}/;
const R_WEEKLY_RESET_FIRST = /weeklyUsage:\s*\$R\[\d+\]\s*=\s*\{[^}]*resetInSec\s*:\s*(-?\d+(?:\.\d+)?)[^}]*usagePercent\s*:\s*(-?\d+(?:\.\d+)?)[^}]*\}/;
const R_MONTHLY_PCT_FIRST = /monthlyUsage:\s*\$R\[\d+\]\s*=\s*\{[^}]*usagePercent\s*:\s*(-?\d+(?:\.\d+)?)[^}]*resetInSec\s*:\s*(-?\d+(?:\.\d+)?)[^}]*\}/;
const R_MONTHLY_RESET_FIRST = /monthlyUsage:\s*\$R\[\d+\]\s*=\s*\{[^}]*resetInSec\s*:\s*(-?\d+(?:\.\d+)?)[^}]*usagePercent\s*:\s*(-?\d+(?:\.\d+)?)[^}]*\}/;
const WORKSPACE_ID_RE = /wrk_[A-Za-z0-9]+/g;
const WORKSPACE_ENTRY_RE = /id\s*:\s*"(wrk_[^"]+)"[^{}]*?name\s*:\s*"([^"]*)"/gs;
const RECORD_ANCHOR_RE = /id:\s*"(usg_[^"]+)"/g;
const PLAN_RE = /id:\s*"(usg_[^"]+)"[^}]*?enrichment:\$R\[\d+\]=\{plan:"([^"]+)"\}/gs;
const CREATED_RE = /timeCreated:\s*\$R\[\d+\]\s*=\s*new Date\("([^"]+)"\)/;
const KEY_ENTRY_RE = /\{id:"(key_[A-Za-z0-9]+)",name:"([^"]*)"/g;

export class AuthError extends Error { constructor(m){ super(m); this.name="AuthError"; } }
export class OpenCodeAPIError extends Error { constructor(m){ super(m); this.name="OpenCodeAPIError"; } }

function clampPercent(v){ return Math.max(0, Math.min(100, v)); }

function parseWindow(pctFirst, resetFirst, html){
  let m = pctFirst.exec(html);
  if(m) return [parseFloat(m[1]), parseInt(String(parseFloat(m[2])),10)];
  m = resetFirst.exec(html);
  if(m) return [parseFloat(m[2]), parseInt(String(parseFloat(m[1])),10)];
  return null;
}
export function parseQuotaHtml(html, now = new Date()){
  const windows=[];
  const pairs=[
    [LABEL_ROLLING, R_ROLLING_PCT_FIRST, R_ROLLING_RESET_FIRST],
    [LABEL_WEEKLY, R_WEEKLY_PCT_FIRST, R_WEEKLY_RESET_FIRST],
    [LABEL_MONTHLY, R_MONTHLY_PCT_FIRST, R_MONTHLY_RESET_FIRST],
  ];
  for(const [label, pctRe, resetRe] of pairs){
    const parsed = parseWindow(pctRe, resetRe, html);
    if(parsed){
      const used = clampPercent(parsed[0]);
      const resetIn = parsed[1];
      const resetAt = new Date(now.getTime() + resetIn*1000);
      windows.push({
        label, used: Math.round(used*10)/10,
        remaining: Math.round((100-used)*10)/10,
        total: 100, unit: "%",
        reset_at: resetAt.toISOString().replace("+00:00","Z"),
        reset_in_sec: resetIn
      });
    }
  }
  return windows;
}

export function extractWorkspaceId(raw){
  if(!raw) return "";
  const v = raw.trim();
  if(v.startsWith("wrk_") && v.length>4) return v;
  const m = v.match(/wrk_[A-Za-z0-9]+/);
  return m? m[0] : "";
}

async function fetchText(url, opts={}, retries=3){
  const backoff=[500,1500,3000];
  let lastErr;
  for(let attempt=0; attempt<retries; attempt++){
    try{
      const resp = await fetch(url, { credentials:"include", ...opts });
      if(resp.status===401 || resp.status===403) throw new AuthError(`认证失败 (HTTP ${resp.status})，请重新登录`);
      if(resp.status===404) throw new OpenCodeAPIError("工作区不存在 (HTTP 404)");
      if(!resp.ok) throw new OpenCodeAPIError(`请求返回 HTTP ${resp.status}`);
      const txt = await resp.text();
      if(txt.length > 4*1024*1024) throw new OpenCodeAPIError("响应过大");
      return txt;
    }catch(e){
      if(e instanceof AuthError || e instanceof OpenCodeAPIError) throw e;
      lastErr=e;
      if(attempt<retries-1) await new Promise(r=>setTimeout(r, backoff[Math.min(attempt, backoff.length-1)]));
    }
  }
  throw new OpenCodeAPIError(`网络错误: ${lastErr && lastErr.message || lastErr}`);
}

async function serverCall(serverId, args, refererPath){
  const url = `https://opencode.ai/_server?id=${encodeURIComponent(serverId)}&args=${encodeURIComponent(JSON.stringify(args))}`;
  const headers = {
    "X-Server-Id": serverId,
    "X-Server-Instance": `server-fn:${Date.now()*1000}`,
    "Accept": "text/javascript, application/json;q=0.9, */*;q=0.8",
  };
  // referrer set via fetch option; some servers check Origin/Referer but we set Referer header via referrer
  return fetchText(url, { headers, referrer:`https://opencode.ai${refererPath}`, referrerPolicy:"strict-origin-when-cross-origin" });
}

export async function fetchWorkspaceRefs(){
  const url = `https://opencode.ai/_server?id=${encodeURIComponent(WORKSPACE_SERVER_ID)}`;
  const headers = {
    "X-Server-Id": WORKSPACE_SERVER_ID,
    "X-Server-Instance": `server-fn:${Date.now()*1000}`,
    "Accept": "text/javascript, application/json;q=0.9, */*;q=0.8",
  };
  const text = await fetchText(url, { headers, referrer:"https://opencode.ai", referrerPolicy:"strict-origin-when-cross-origin" });
  const entries=[];
  let m;
  WORKSPACE_ENTRY_RE.lastIndex=0;
  while((m=WORKSPACE_ENTRY_RE.exec(text))){
    entries.push([m[1], m[2]]);
  }
  if(entries.length===0){
    // fallback: regex wrk_ ids uniqueness
    const ids=new Set();
    const re2= /wrk_[A-Za-z0-9]+/g;
    let mm;
    while((mm=re2.exec(text))){
      if(!ids.has(mm[0])){ ids.add(mm[0]); entries.push([mm[0], ""]);}
    }
  }
  return entries; // [[id,name],...]
}

export async function resolveWorkspaceId(hint, fallbackWorkspaceId){
  const h=(hint||"").trim();
  if(h.startsWith("wrk_")) return h;
  // try extract wrk_ from hint
  const extracted=extractWorkspaceId(h);
  if(extracted) return extracted;
  try{
    const refs=await fetchWorkspaceRefs();
    if(!refs.length) throw new OpenCodeAPIError("无法获取工作区列表");
    if(!h || h.toLowerCase()==="default"){
      return refs[0][0];
    }
    const hl=h.toLowerCase();
    for(const [wid,name] of refs){
      if(wid.toLowerCase()===hl || (name && name.toLowerCase()===hl)) return wid;
    }
    return refs[0][0];
  }catch(e){
    if(fallbackWorkspaceId && fallbackWorkspaceId.startsWith("wrk_")) return fallbackWorkspaceId;
    throw e;
  }
}

export async function fetchQuota(workspaceHint){
  const now=new Date();
  const updatedAt=now.toISOString().replace("+00:00","Z");
  const hint=(workspaceHint||"Default").trim()||"Default";
  try{
    const workspaceId=await resolveWorkspaceId(hint, hint);
    const url=`${DASHBOARD_BASE}/${encodeURIComponent(workspaceId)}/go`;
    const html=await fetchText(url, { referrer:`https://opencode.ai/workspace/${workspaceId}/go` }, 2);
    const windows=parseQuotaHtml(html, now);
    if(!windows.length) throw new OpenCodeAPIError("无法从 Dashboard HTML 解析额度数据");
    return { name:"Default", workspace_id:workspaceId, success:true, updated_at:updatedAt, windows };
  }catch(e){
    return { name:"Default", workspace_id:hint, success:false, updated_at:updatedAt, error:String(e.message||e) };
  }
}

function parseNumField(body, name){
  const re=new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}:\\s*(\\d+|null)`);
  const m=re.exec(body);
  if(!m) return 0;
  if(m[1]==="null") return 0;
  const n=parseInt(m[1],10);
  return Number.isNaN(n)?0:n;
}
function parseStrField(body, name){
  const re=new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}:\\s*"([^"]*)"`);
  const m=re.exec(body);
  return m? m[1] : "";
}

export function parseUsageResponse(text){
  const plans=new Map();
  PLAN_RE.lastIndex=0;
  let m;
  while((m=PLAN_RE.exec(text))){
    plans.set(m[1], m[2]);
  }
  const anchors=[...text.matchAll(RECORD_ANCHOR_RE)];
  const records=[];
  for(let i=0;i<anchors.length;i++){
    const mm=anchors[i];
    const usgId=mm[1];
    const start=mm.index + mm[0].length;
    const end= i+1<anchors.length? anchors[i+1].index : text.length;
    const body=text.slice(start, end);
    const createdMatch=CREATED_RE.exec(body);
    if(!createdMatch) continue;
    records.push({
      usg_id: usgId,
      created_at: createdMatch[1],
      model: parseStrField(body,"model"),
      provider: parseStrField(body,"provider"),
      input_tokens: parseNumField(body,"inputTokens"),
      output_tokens: parseNumField(body,"outputTokens"),
      reasoning_tokens: parseNumField(body,"reasoningTokens"),
      cache_read_tokens: parseNumField(body,"cacheReadTokens"),
      cache_write_5m_tokens: parseNumField(body,"cacheWrite5mTokens"),
      cache_write_1h_tokens: parseNumField(body,"cacheWrite1hTokens"),
      cost_raw: parseNumField(body,"cost"),
      key_id: parseStrField(body,"keyID"),
      session_id: parseStrField(body,"sessionID"),
      plan: plans.get(usgId) || null,
      get cost_usd(){ return this.cost_raw / 1e8; }
    });
  }
  // normalize cost_usd as value, not getter after JSON
  return records.map(r=>({ ...r, cost_usd: r.cost_raw/1e8 }));
}

export async function fetchUsagePage(workspaceId, page=0, keyId=null, usageServerId=null){
  const args=[workspaceId];
  if(keyId){
    if(page>0){ args.push(page, keyId); } else { args.push(keyId); }
  }else if(page>0){
    args.push(page);
  }
  const serverId=usageServerId || DEFAULT_USAGE_SERVER_ID;
  const text=await serverCall(serverId, args, `/workspace/${workspaceId}/usage`);
  return parseUsageResponse(text);
}

export async function fetchKeyNames(workspaceId){
  const url=`https://opencode.ai/workspace/${workspaceId}/keys`;
  try{
    const html=await fetchText(url, { referrer:`https://opencode.ai/workspace/${workspaceId}/keys` }, 2);
    const names={};
    let m;
    KEY_ENTRY_RE.lastIndex=0;
    while((m=KEY_ENTRY_RE.exec(html))){
      const kid=m[1], name=m[2].trim();
      if(kid && name && !names[kid]) names[kid]=name;
    }
    return names;
  }catch(e){
    return {};
  }
}
