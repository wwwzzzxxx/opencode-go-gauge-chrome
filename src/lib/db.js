// IndexedDB wrapper — mirrors opencode-go-gauge logic but in browser + ServiceWorker
const DB_NAME = "goGauge";
const DB_VERSION = 4;
const STORE = "usage_records";
const META_STORE = "meta";
let dbPromise=null;

function getIDB(){
  // ServiceWorker vs Window: indexedDB may be on globalThis or self
  if(typeof indexedDB !== "undefined") return indexedDB;
  if(typeof self !== "undefined" && self.indexedDB) return self.indexedDB;
  if(typeof globalThis !== "undefined" && globalThis.indexedDB) return globalThis.indexedDB;
  throw new Error("IndexedDB not available in this context");
}

function openDB(){
  if(dbPromise) return dbPromise;
  const idb=getIDB();
  dbPromise=new Promise((resolve,reject)=>{
    const req=idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded=(e)=>{
      const db=e.target.result;
      if(!db.objectStoreNames.contains(STORE)){
        const s=db.createObjectStore(STORE,{keyPath:"usg_id"});
        s.createIndex("created_at","created_at");
        s.createIndex("model","model");
        s.createIndex("session_id","session_id");
      }else{
        const s=e.target.transaction.objectStore(STORE);
        if(!s.indexNames.contains("created_at")) s.createIndex("created_at","created_at");
        if(!s.indexNames.contains("model")) s.createIndex("model","model");
        if(!s.indexNames.contains("session_id")) s.createIndex("session_id","session_id");
      }
      if(!db.objectStoreNames.contains(META_STORE)){
        db.createObjectStore(META_STORE,{keyPath:"key"});
      }
      if(!db.objectStoreNames.contains("quota")){
        db.createObjectStore("quota",{keyPath:"key"});
      }
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
    req.onblocked=()=>console.warn("[GoGauge] IndexedDB blocked");
  });
  return dbPromise;
}

export async function bulkPutRecords(records){
  if(!records.length) return 0;
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readwrite");
    const st=tx.objectStore(STORE);
    for(const r of records){ st.put(r); }
    tx.oncomplete=()=>resolve(records.length);
    tx.onerror=()=>reject(tx.error);
  });
}
export async function countRecords(){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readonly");
    const req=tx.objectStore(STORE).count();
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
export async function getAllRecords(){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readonly");
    const req=tx.objectStore(STORE).getAll();
    req.onsuccess=()=>resolve(req.result||[]);
    req.onerror=()=>reject(req.error);
  });
}
export async function clearAllRecords(){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
  });
}
export async function pruneOldRecords(windowDays){
  if(!windowDays) return 0;
  const boundary=Date.now() - windowDays*24*3600*1000;
  const all=await getAllRecords();
  const toDelete=all.filter(r=> new Date(r.created_at).getTime() < boundary);
  if(!toDelete.length) return 0;
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readwrite");
    const st=tx.objectStore(STORE);
    for(const r of toDelete) st.delete(r.usg_id);
    tx.oncomplete=()=>resolve(toDelete.length);
    tx.onerror=()=>reject(tx.error);
  });
}
function periodFilter(period, createdAt){
  if(period==="all" || !period) return true;
  if(period==="today"){
    const d=new Date(createdAt);
    const now=new Date();
    return d.toISOString().slice(0,10)===now.toISOString().slice(0,10);
  }
  const m=period.match(/^(\d+)d$/);
  let days=30;
  if(period==="7d") days=7;
  else if(period==="30d") days=30;
  else if(m) days=parseInt(m[1],10);
  const boundary=Date.now() - days*24*3600*1000;
  return new Date(createdAt).getTime() >= boundary;
}
export async function getFilteredRecords(period="30d", modelFilter){
  const all=await getAllRecords();
  let filtered=all.filter(r=> periodFilter(period, r.created_at));
  if(modelFilter) filtered=filtered.filter(r=> r.model===modelFilter);
  filtered.sort((a,b)=> new Date(b.created_at)-new Date(a.created_at));
  return filtered;
}
export async function computeTotals(period="30d"){
  const recs=await getFilteredRecords(period);
  if(!recs.length) return { request_count:0, session_count:0, total_input_tokens:0, uncached_input_tokens:0, total_reasoning_tokens:0, cache_hit_tokens:0, cache_write_tokens:0, total_output_tokens:0, total_cost_usd:0, hit_rate:0 };
  let total_input=0, uncached=0, reasoning=0, hit=0, write=0, out=0, cost=0;
  const sessions=new Set();
  for(const r of recs){
    total_input += (r.input_tokens||0)+(r.cache_read_tokens||0)+(r.cache_write_5m_tokens||0)+(r.cache_write_1h_tokens||0);
    uncached += (r.input_tokens||0);
    reasoning += (r.reasoning_tokens||0);
    hit += (r.cache_read_tokens||0);
    write += (r.cache_write_5m_tokens||0)+(r.cache_write_1h_tokens||0);
    out += (r.output_tokens||0);
    cost += (r.cost_usd||0);
    if(r.session_id) sessions.add(r.session_id);
  }
  const denom=hit+uncached;
  const hitRate= denom? (hit/denom*100) : 0;
  return {
    request_count: recs.length,
    session_count: sessions.size,
    total_input_tokens: total_input,
    uncached_input_tokens: uncached,
    total_reasoning_tokens: reasoning,
    cache_hit_tokens: hit,
    cache_write_tokens: write,
    total_output_tokens: out,
    total_cost_usd: Math.round(cost*1e6)/1e6,
    hit_rate: Math.round(hitRate*100)/100
  };
}
export async function computeModelStats(period="30d"){
  const recs=await getFilteredRecords(period);
  const map=new Map();
  for(const r of recs){
    const key=r.model||"unknown";
    let cur=map.get(key);
    if(!cur) cur={ model:key, request_count:0, uncached_input_tokens:0, total_output_tokens:0, total_reasoning_tokens:0, cache_hit_tokens:0, cache_write_tokens:0, total_cost_usd:0 };
    cur.request_count++;
    cur.uncached_input_tokens += r.input_tokens||0;
    cur.total_output_tokens += r.output_tokens||0;
    cur.total_reasoning_tokens += r.reasoning_tokens||0;
    cur.cache_hit_tokens += r.cache_read_tokens||0;
    cur.cache_write_tokens += (r.cache_write_5m_tokens||0)+(r.cache_write_1h_tokens||0);
    cur.total_cost_usd += r.cost_usd||0;
    map.set(key, cur);
  }
  for(const v of map.values()){
    v.total_input_tokens=(v.uncached_input_tokens+v.cache_hit_tokens+v.cache_write_tokens);
    const denom=v.cache_hit_tokens+v.uncached_input_tokens;
    v.hit_rate= denom? Math.round(v.cache_hit_tokens/denom*100*100)/100 : 0;
    v.total_cost_usd=Math.round(v.total_cost_usd*1e6)/1e6;
  }
  const arr=[...map.values()];
  arr.sort((a,b)=> (b.uncached_input_tokens+b.cache_hit_tokens) - (a.uncached_input_tokens+a.cache_hit_tokens));
  return arr;
}
export async function computeDailyStats(days=30){
  const all=await getAllRecords();
  const map=new Map();
  for(const r of all){
    const d=r.created_at.slice(0,10);
    let cur=map.get(d);
    if(!cur) cur={ date:d, request_count:0, uncached_input_tokens:0, total_output_tokens:0, total_cost_usd:0, cache_hit_tokens:0, total_tokens:0 };
    cur.request_count++;
    cur.uncached_input_tokens += r.input_tokens||0;
    cur.total_output_tokens += r.output_tokens||0;
    cur.cache_hit_tokens += r.cache_read_tokens||0;
    cur.total_cost_usd += r.cost_usd||0;
    cur.total_tokens += (r.input_tokens||0)+(r.output_tokens||0)+(r.reasoning_tokens||0);
    map.set(d, cur);
  }
  const arr=[...map.values()].sort((a,b)=> a.date.localeCompare(b.date));
  const sliced=arr.slice(-days);
  for(const x of sliced) x.total_cost_usd=Math.round(x.total_cost_usd*1e6)/1e6;
  return sliced;
}
export async function computeTodayTrend(){
  const now=new Date();
  const buckets=Array.from({length:24},(_,h)=>({ hour:h, label:String(h).padStart(2,"0")+":00", input:0, output:0, count:0 }));
  const all=await getAllRecords();
  for(const r of all){
    const d=new Date(r.created_at);
    if(d.toISOString().slice(0,10) !== now.toISOString().slice(0,10)) continue;
    const h=d.getHours();
    buckets[h].input += r.input_tokens||0;
    buckets[h].output += r.output_tokens||0;
    buckets[h].count++;
  }
  return buckets;
}
export async function listModels(){
  const all=await getAllRecords();
  const s=new Set(all.map(r=> r.model).filter(Boolean));
  return [...s].sort();
}
export async function getRecordsPage(page=1, pageSize=20, period="all", modelFilter=""){
  const filtered=await getFilteredRecords(period, modelFilter||undefined);
  const total=filtered.length;
  const totalPages=Math.max(1, Math.ceil(total/pageSize));
  const safePage=Math.min(Math.max(1,page), totalPages);
  const start=(safePage-1)*pageSize;
  const items=filtered.slice(start, start+pageSize);
  return { items, total, page:safePage, totalPages, pageSize };
}
export async function getSessionStats(page=1, pageSize=20, period="30d"){
  const recs=await getFilteredRecords(period);
  const map=new Map();
  for(const r of recs){
    const sid=r.session_id||"(no session)";
    let cur=map.get(sid);
    if(!cur) cur={ session_id:sid, request_count:0, uncached_input_tokens:0, cache_hit_tokens:0, total_output_tokens:0, total_reasoning_tokens:0, total_cost_usd:0, models:new Set(), earliest:r.created_at, latest:r.created_at };
    cur.request_count++;
    cur.uncached_input_tokens += r.input_tokens||0;
    cur.cache_hit_tokens += r.cache_read_tokens||0;
    cur.total_output_tokens += r.output_tokens||0;
    cur.total_reasoning_tokens += r.reasoning_tokens||0;
    cur.total_cost_usd += r.cost_usd||0;
    if(r.model) cur.models.add(r.model);
    if(r.created_at < cur.earliest) cur.earliest=r.created_at;
    if(r.created_at > cur.latest) cur.latest=r.created_at;
  }
  let arr=[...map.values()].map(v=>({ ...v, models:[...v.models].join(", "), total_cost_usd: Math.round(v.total_cost_usd*1e6)/1e6, total_tokens: v.uncached_input_tokens+v.cache_hit_tokens+v.total_output_tokens+v.total_reasoning_tokens }));
  arr.sort((a,b)=> new Date(b.latest)-new Date(a.latest));
  const total=arr.length;
  const totalPages=Math.max(1, Math.ceil(total/pageSize));
  const safePage=Math.min(Math.max(1,page), totalPages);
  const start=(safePage-1)*pageSize;
  return { items: arr.slice(start, start+pageSize), total, page:safePage, totalPages, pageSize };
}
export async function getSessionStats2(page=1,pageSize=20,period="30d"){
  const recs=await getFilteredRecords(period);
  const map=new Map();
  for(const r of recs){
    const sid=r.session_id||"(no session)";
    let cur=map.get(sid);
    if(!cur) cur={ session_id:sid, request_count:0, uncached_input_tokens:0, cache_hit_tokens:0, total_output_tokens:0, total_reasoning_tokens:0, total_cost_usd:0, models:new Set(), earliest:r.created_at, latest:r.created_at };
    cur.request_count++;
    cur.uncached_input_tokens += r.input_tokens||0;
    cur.cache_hit_tokens += r.cache_read_tokens||0;
    cur.total_output_tokens += r.output_tokens||0;
    cur.total_reasoning_tokens += r.reasoning_tokens||0;
    cur.total_cost_usd += r.cost_usd||0;
    if(r.model) cur.models.add(r.model);
    if(r.created_at < cur.earliest) cur.earliest=r.created_at;
    if(r.created_at > cur.latest) cur.latest=r.created_at;
  }
  let arr=[...map.values()].map(v=>({ ...v, models:[...v.models].join(", "), total_cost_usd: Math.round(v.total_cost_usd*1e6)/1e6, total_tokens: v.uncached_input_tokens+v.cache_hit_tokens+v.total_output_tokens+v.total_reasoning_tokens }));
  arr.sort((a,b)=> new Date(b.latest)-new Date(a.latest));
  const total=arr.length;
  const totalPages=Math.max(1, Math.ceil(total/pageSize));
  const safePage=Math.min(Math.max(1,page), totalPages);
  const start=(safePage-1)*pageSize;
  return { items: arr.slice(start, start+pageSize), total, page:safePage, totalPages, pageSize };
}
export async function setMeta(key, value){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(META_STORE,"readwrite");
    tx.objectStore(META_STORE).put({key, value, updated_at:new Date().toISOString()});
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
  });
}
export async function getMeta(key){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(META_STORE,"readonly");
    const req=tx.objectStore(META_STORE).get(key);
    req.onsuccess=()=>resolve(req.result? req.result.value : null);
    req.onerror=()=>reject(req.error);
  });
}
export async function getQuotaCache(){ return getMeta("quota"); }
export async function setQuotaCache(v){ return setMeta("quota", v); }
