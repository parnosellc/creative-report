// ============================================================
//  Creative Performance Report — Railway server
//  Zero dependencies. Node 18+ (built-in fetch, http, crypto, fs).
//  Token lives only in env vars and never reaches the browser.
// ============================================================

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const FB_TOKEN   = process.env.CPR_FB_TOKEN || "";
const FB_ACCOUNTS = (process.env.CPR_FB_AD_ACCOUNTS || "")
  .split(",").map(s => s.trim()).filter(Boolean)
  .map(s => s.startsWith("act_") ? s : "act_" + s);
const API_VERSION = process.env.CPR_FB_API_VERSION || "v21.0";
const SECRET = process.env.CPR_SECRET || "app";
const DATA_DIR = process.env.CPR_DATA_DIR || path.join(__dirname, "data");
const SNAP_DIR = path.join(DATA_DIR, "snapshots");
const ATTRIBUTION = "1d_click";
const FB_GRAPH = `https://graph.facebook.com/${API_VERSION}`;
const CACHE_TTL_MS = 45 * 60 * 1000;        // reuse a pull for 45 min
const SNAP_TTL_MS = 90 * 24 * 60 * 60 * 1000; // delete snapshots after 90 days

// ---------- small helpers ----------
function chunk(a, n){ const o=[]; for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n)); return o; }
function actionValue(act, w){ if(act[w]!=null)return parseFloat(act[w])||0; if(act.value!=null)return parseFloat(act.value)||0; return 0; }

async function fbGet(url){
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  return r.json();
}

// Classify a creative: fresh video ad? plus a human label. (Same rules as the UI.)
function classify(c){
  c = c || {};
  const spec = c.object_story_spec || {};
  const ld = spec.link_data || {};
  const isPID = !!c.object_story_id && !spec.video_data && !spec.link_data && !spec.photo_data;
  const isVideo = !isPID && (!!spec.video_data || (!!c.video_id && !c.object_story_id));
  let type = "Other";
  if (isVideo) type = "Video";
  else if (isPID) type = "Post (PID)";
  else if (Array.isArray(ld.child_attachments) && ld.child_attachments.length > 1) type = "Carousel";
  else if (spec.photo_data || spec.link_data) type = "Image";
  else if (c.object_story_id) type = "Post (PID)";
  else if (c.object_type) type = c.object_type.charAt(0) + c.object_type.slice(1).toLowerCase();
  return { isVideo, type };
}

// ---------- the full pull (token-side) ----------
async function pullReport(since, until){
  // step 1: ad-level insights by country, parallel accounts, minimal fields
  const ads = new Map();
  const totals = new Map();
  const ensure = (id) => { if(!ads.has(id)) ads.set(id, {acct:"", US:{spend:0,actions:new Map()}, ROW:{spend:0,actions:new Map()}}); return ads.get(id); };

  await Promise.all(FB_ACCOUNTS.map(async (acct) => {
    const acctNum = acct.replace("act_","");
    const p = new URLSearchParams({ level:"ad", breakdowns:"country", fields:"ad_id,spend,actions",
      action_attribution_windows: JSON.stringify([ATTRIBUTION]),
      time_range: JSON.stringify({since, until}), limit:"1000", access_token: FB_TOKEN });
    let url = `${FB_GRAPH}/${acct}/insights?${p}`;
    let pages = 0;
    while (url){
      const json = await fbGet(url);
      if (json.error) throw new Error(`Facebook error on ${acct}: ${json.error.message}`);
      for (const r of json.data || []){
        const id = r.ad_id; if(!id) continue;
        const region = (r.country === "US") ? "US" : "ROW";
        const a = ensure(id); if(!a.acct) a.acct = acctNum;
        const b = a[region]; b.spend += parseFloat(r.spend)||0;
        for (const act of r.actions || []){ const v = actionValue(act, ATTRIBUTION); if(!v) continue;
          b.actions.set(act.action_type, (b.actions.get(act.action_type)||0)+v);
          totals.set(act.action_type, (totals.get(act.action_type)||0)+v); }
      }
      pages++; url = json.paging && json.paging.next ? json.paging.next : null; if(pages>400) break;
    }
  }));

  // step 2: per-ad details (name, funnel, creation date, creative type), batched
  const ids = [...ads.keys()];
  const metaByAd = new Map();
  await Promise.all(chunk(ids, 50).map(async (b) => {
    const p = new URLSearchParams({ ids: b.join(","),
      fields: "name,created_time,campaign{name},creative{object_type,video_id,object_story_id,object_story_spec}",
      access_token: FB_TOKEN });
    let json = null;
    try { const r = await fbGet(`${FB_GRAPH}/?${p}`); if(!r.error) json = r; } catch(_){}
    for (const id of b){
      const n = (json && json[id]) || {};
      const t = n.created_time ? Date.parse(n.created_time) : NaN;
      const campName = (n.campaign && n.campaign.name) || "";
      metaByAd.set(id, { name: n.name || id, funnel: /FCVSL/i.test(campName) ? "FCVSL" : "Toolkit",
        created: isNaN(t) ? null : t, ...classify(n.creative || {}) });
    }
  }));

  const rows = [...ads].map(([id, a]) => {
    const m = metaByAd.get(id) || {name:id, funnel:"Toolkit", created:null, isVideo:false, type:"Unknown"};
    return { id, name:m.name, funnel:m.funnel, acct:a.acct, created:m.created, isVideo:m.isVideo, type:m.type,
      US:{spend:Math.round(a.US.spend*100)/100, actions:Object.fromEntries(a.US.actions)},
      ROW:{spend:Math.round(a.ROW.spend*100)/100, actions:Object.fromEntries(a.ROW.actions)} };
  });
  const actionTypes = [...totals].sort((a,b)=>b[1]-a[1]).map(([type,total])=>({type, total:Math.round(total)}));
  let guessFb = "";
  for (const t of ["offsite_conversion.fb_pixel_purchase","purchase","omni_purchase","onsite_web_purchase"])
    if (actionTypes.some(x=>x.type===t)) { guessFb=t; break; }
  return { rows, actionTypes, guessFb };
}

// 45-min cache keyed by date range
const reportCache = new Map();
// Background jobs so a single HTTP request never blocks long enough to hit
// Railway's ~120s edge timeout. The client polls; the pull runs detached.
const jobs = new Map(); // key -> { status:'running'|'done'|'error', data, error, startedAt }
function reportKey(since, until){ return since + "|" + until; }

// Non-blocking: returns the current state immediately, kicking off a pull if needed.
function startOrPoll(since, until){
  const key = reportKey(since, until);
  const hit = reportCache.get(key);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return { status:"done", data: hit.data };

  const job = jobs.get(key);
  if (job){
    if (job.status === "running") return { status:"running", elapsed: Date.now() - job.startedAt };
    if (job.status === "done")    return { status:"done", data: job.data };
    if (job.status === "error"){ jobs.delete(key); /* fall through and restart */ }
  }

  const startedAt = Date.now();
  jobs.set(key, { status:"running", startedAt });
  pullReport(since, until)
    .then(data => { reportCache.set(key, { data, ts: Date.now() }); jobs.set(key, { status:"done", data, startedAt }); })
    .catch(e  => { jobs.set(key, { status:"error", error: String(e && e.message || e), startedAt }); });
  return { status:"running", elapsed: 0 };
}

// ---------- thumbnails → base64 data URLs (token-side, no CORS issues) ----------
async function thumbsBase64(ids){
  const urlByAd = new Map();
  await Promise.all(chunk(ids, 50).map(async (b) => {
    let json = null;
    for (const fs2 of ["creative{thumbnail_url,image_url}","creative{thumbnail_url}"]){
      const p = new URLSearchParams({ ids: b.join(","), fields: fs2, access_token: FB_TOKEN });
      try { const r = await fbGet(`${FB_GRAPH}/?${p}`); if(r.error){ json=null; continue; } json=r; break; } catch(_){ json=null; }
    }
    for (const id of b){ const c = json && json[id] && json[id].creative; urlByAd.set(id, c ? (c.thumbnail_url || c.image_url || "") : ""); }
  }));
  const out = {};
  await Promise.all([...urlByAd].map(async ([id, u]) => {
    if(!u){ out[id]=""; return; }
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
      const ct = res.headers.get("content-type") || "image/jpeg";
      const buf = Buffer.from(await res.arrayBuffer());
      out[id] = `data:${ct};base64,${buf.toString("base64")}`;
    } catch(_){ out[id] = ""; }
  }));
  return out;
}

// ---------- snapshot storage ----------
function ensureDirs(){ fs.mkdirSync(SNAP_DIR, { recursive: true }); }
function saveSnapshot(html){
  ensureDirs();
  const id = crypto.randomBytes(9).toString("hex");
  fs.writeFileSync(path.join(SNAP_DIR, id + ".html"), html);
  return id;
}
function readSnapshot(id){
  if(!/^[a-f0-9]{6,40}$/.test(id)) return null;
  const f = path.join(SNAP_DIR, id + ".html");
  try {
    const st = fs.statSync(f);
    if (Date.now() - st.mtimeMs > SNAP_TTL_MS){ fs.unlinkSync(f); return null; }
    return fs.readFileSync(f, "utf8");
  } catch(_){ return null; }
}
function sweepSnapshots(){
  try {
    ensureDirs();
    for (const f of fs.readdirSync(SNAP_DIR)){
      const full = path.join(SNAP_DIR, f);
      try { if (Date.now() - fs.statSync(full).mtimeMs > SNAP_TTL_MS) fs.unlinkSync(full); } catch(_){}
    }
  } catch(_){}
}

// ---------- HTTP plumbing ----------
function send(res, code, type, body){ res.writeHead(code, { "Content-Type": type }); res.end(body); }
function json(res, code, obj){ send(res, code, "application/json", JSON.stringify(obj)); }
function readBody(req){ return new Promise((resolve)=>{ let d=""; req.on("data",c=>{ d+=c; if(d.length>8e6) req.destroy(); }); req.on("end",()=>resolve(d)); }); }

const INDEX_HTML = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
let SEG_HTML=""; try{ SEG_HTML=fs.readFileSync(path.join(__dirname, "segment-report.html"),"utf8"); }catch(e){ SEG_HTML="Segment report not built yet."; }

async function handler(req, res){
  const u = new URL(req.url, "http://x");
  const parts = u.pathname.split("/").filter(Boolean); // e.g. ["<secret>","api","report"]

  // public snapshot — no secret, no token
  if (parts[0] === "s" && parts[1]){
    const html = readSnapshot(parts[1]);
    if (!html) return send(res, 404, "text/plain", "Snapshot not found or expired.");
    return send(res, 200, "text/html; charset=utf-8", html);
  }

  // health check (handy for debugging)
  if (parts[0] === "healthz") return json(res, 200, { ok:true, accounts: FB_ACCOUNTS.length, tokenSet: !!FB_TOKEN });

  // segment performance report (static, public random path)
  if (parts[0] === "segments-72a49538") return send(res, 200, "text/html; charset=utf-8", SEG_HTML);

  // everything else is gated behind the secret path segment
  if (parts[0] !== SECRET) return send(res, 404, "text/plain", "Not found.");

  const sub = parts.slice(1); // after secret

  // live report UI
  if (sub.length === 0) return send(res, 200, "text/html; charset=utf-8", INDEX_HTML);

  if (sub[0] === "api" && sub[1] === "report"){
    try {
      const since = u.searchParams.get("since"), until = u.searchParams.get("until");
      if(!since || !until) throw new Error("Missing date range.");
      if(!FB_TOKEN) throw new Error("Server missing CPR_FB_TOKEN.");
      return json(res, 200, startOrPoll(since, until)); // returns instantly: {status:'running'|'done'|'error'}
    } catch(e){ return json(res, 500, { error: e.message }); }
  }

  if (sub[0] === "api" && sub[1] === "thumbs"){
    try {
      const ids = (u.searchParams.get("ids")||"").split(",").map(s=>s.trim()).filter(Boolean);
      return json(res, 200, await thumbsBase64(ids));
    } catch(e){ return json(res, 500, { error: e.message }); }
  }

  if (sub[0] === "api" && sub[1] === "snapshot" && req.method === "POST"){
    try {
      const html = await readBody(req);
      if(!html || html.length < 50) throw new Error("Empty snapshot.");
      const id = saveSnapshot(html);
      return json(res, 200, { path: "/s/" + id });
    } catch(e){ return json(res, 500, { error: e.message }); }
  }

  return send(res, 404, "text/plain", "Not found.");
}

function startServer(){
  if (SECRET === "app") console.warn("WARNING: CPR_SECRET not set — using 'app'. Set a long random CPR_SECRET.");
  if (!FB_TOKEN) console.warn("WARNING: CPR_FB_TOKEN not set.");
  ensureDirs(); sweepSnapshots();
  setInterval(sweepSnapshots, 24*60*60*1000);
  const PORT = process.env.PORT || 8787;   // never set PORT yourself — Railway injects it
  http.createServer((req,res)=>handler(req,res).catch(e=>{ try{ json(res,500,{error:String(e&&e.message||e)}); }catch(_){} }))
    .listen(PORT, () => console.log("Creative Performance Report listening on " + PORT + "  (live path: /" + SECRET + "/)"));
}

if (require.main === module) startServer();
module.exports = { classify, actionValue, chunk, pullReport, saveSnapshot, readSnapshot, sweepSnapshots };
