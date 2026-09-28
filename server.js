/**
 * 英语语感训练器 - 部署服务（含账号系统）
 * - 托管 index.html
 * - /api/llm 代理 LLM 请求（Key 只存在本服务器，不暴露给浏览器）
 * - /api/register /api/login /api/data：账号系统，练习数据按账号存储在 data/<user>.json
 *
 * 用法（环境变量或同目录 .env）：
 *   LLM_BASE_URL / LLM_MODEL / LLM_API_KEY / PORT
 *   node server.js
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---- 配置 ----
(function loadEnv(){
  try{
    const t = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for(const line of t.split(/\r?\n/)){
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
      if(m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }catch(e){}
})();
const CFG = {
  baseUrl: (process.env.LLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4").replace(/\/$/, ""),
  model: process.env.LLM_MODEL || "glm-4.6",
  key: process.env.LLM_API_KEY || ""
};
if(!CFG.key){ console.error("缺少 LLM_API_KEY（环境变量或 .env）"); process.exit(1); }
const PORT = +(process.env.PORT || 8787);
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, {recursive:true});

// ---- 账号存储 ----
const USER_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/;
const users = new Map(); // user -> {salt, hash}
function hashPass(pass, salt){
  return crypto.scryptSync(String(pass), salt, 32).toString("hex");
}
function loadUsers(){
  try{
    for(const f of fs.readdirSync(DATA_DIR)){
      if(!f.endsWith(".user.json")) continue;
      const u = f.replace(".user.json","");
      try{ users.set(u, JSON.parse(fs.readFileSync(path.join(DATA_DIR,f),"utf8"))); }catch(e){}
    }
  }catch(e){}
}
loadUsers();
function userFile(u){ return path.join(DATA_DIR, u + ".json"); }
function saveUserMeta(u, meta){ fs.writeFileSync(path.join(DATA_DIR, u+".user.json"), JSON.stringify(meta)); }
function loadData(u){ try{ return JSON.parse(fs.readFileSync(userFile(u),"utf8")); }catch(e){ return null; } }
function saveData(u, d){ fs.writeFileSync(userFile(u), JSON.stringify(d)); }

// 简单内存 session（重启后需重新登录）
const sessions = new Map(); // token -> {user, ts}
const SESSION_TTL = 30*24*3600*1000;
function newToken(){ return crypto.randomBytes(24).toString("hex"); }
function authUser(req){
  const t = (req.headers["authorization"]||"").replace(/^Bearer\s+/i,"");
  const s = sessions.get(t);
  if(!s || Date.now()-s.ts > SESSION_TTL){ sessions.delete(t); return null; }
  s.ts = Date.now();
  return s.user;
}
function json(res, code, obj){
  res.writeHead(code, {"Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store"});
  res.end(JSON.stringify(obj));
}
function readBody(req, cb, limit=2e6){
  let d = "";
  req.on("data", c => { d += c; if(d.length > limit) req.destroy(); });
  req.on("end", ()=>{ try{ cb(JSON.parse(d||"{}")); }catch(e){ json(res,400,{error:"bad json"}); } });
}

function proxyLLM(req, res, body, user){
  const stream = body.stream === true;
  const anthropic = /\/anthropic\/?$/.test(CFG.baseUrl);
  let payload, hdrs;
  if(anthropic){
    // Anthropic messages 协议（GLM 编码套餐端点）
    const sys = (body.messages||[]).filter(m=>m.role==="system").map(m=>m.content).join("\n");
    payload = JSON.stringify({
      model: CFG.model,
      max_tokens: body.max_tokens || +(process.env.LLM_MAX_TOKENS || 8192),
      temperature: body.temperature ?? 0.3,
      ...(sys ? {system: sys} : {}),
      messages: (body.messages||[]).filter(m=>m.role!=="system"),
      ...(stream ? {stream:true} : {})
    });
    hdrs = { "Content-Type":"application/json", "x-api-key":CFG.key,
             "authorization":"Bearer "+CFG.key, "anthropic-version":"2023-06-01" };
  }else{
    payload = JSON.stringify({
      model: CFG.model,
      temperature: body.temperature ?? 0.3,
      messages: body.messages,
      ...(stream ? {stream:true} : {response_format:{type:"json_object"}})
    });
    hdrs = { "Content-Type":"application/json", "Authorization":"Bearer "+CFG.key };
  }
  const u = new URL(CFG.baseUrl + (anthropic ? "/v1/messages" : "/chat/completions"));
  const upstream = (u.protocol === "http:" ? http : https).request({
    hostname: u.hostname, port: u.port || (u.protocol==="http:"?80:443),
    path: u.pathname + u.search, method: "POST",
    headers: { ...hdrs, "Content-Length": Buffer.byteLength(payload) }
  }, up => {
    const ct = up.headers["content-type"] || "application/json";
    res.writeHead(up.statusCode, { "Content-Type": ct, "Cache-Control":"no-store", ...(stream?{"X-Accel-Buffering":"no"}:{}) });
    if(anthropic && stream){
      // Anthropic SSE → OpenAI 风格 SSE（前端只认 data: {choices:[{delta:{content}}]}）
      let buf = "";
      up.on("data", c => {
        buf += c.toString();
        const lines = buf.split("\n"); buf = lines.pop();
        for(const line of lines){
          const s = line.trim();
          if(!s.startsWith("data:")) continue;
          try{
            const j = JSON.parse(s.slice(5).trim());
            if(j.type === "content_block_delta" && j.delta?.text){
              res.write(`data: ${JSON.stringify({choices:[{delta:{content:j.delta.text}}]})}\n\n`);
            }else if(j.type === "message_stop"){
              res.write("data: [DONE]\n\n");
            }
          }catch(e){}
        }
      });
      up.on("end", ()=> res.end());
    }else if(anthropic){
      // Anthropic JSON → OpenAI 风格 JSON
      let buf = "";
      up.on("data", c => buf += c.toString());
      up.on("end", ()=>{
        try{
          const j = JSON.parse(buf);
          res.end(JSON.stringify({choices:[{message:{content:(j.content||[]).map(b=>b.text||"").join("")}}]}));
        }catch(e){ res.end(buf); }
      });
    }else{
      up.pipe(res);
    }
  });
  upstream.on("error", e => { try{ res.writeHead(502, {"Content-Type":"application/json"}); }catch(_){}
    res.end(JSON.stringify({error:String(e)})); });
  upstream.end(payload);
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  // ---- 注册 ----
  if(req.method === "POST" && url === "/api/register"){
    return readBody(req, b => {
      const u = String(b.user||"").trim(), p = String(b.pass||"");
      if(!USER_RE.test(u)) return json(res,400,{error:"用户名 2-20 位，限字母/数字/下划线/中文"});
      if(p.length < 6) return json(res,400,{error:"密码至少 6 位"});
      if(users.has(u)) return json(res,409,{error:"用户名已存在"});
      const salt = crypto.randomBytes(16).toString("hex");
      users.set(u, {salt, hash: hashPass(p, salt)});
      saveUserMeta(u, users.get(u));
      if(!fs.existsSync(userFile(u))) saveData(u, {sentences:[], errors:{}, graded:0, drills:[]});
      const token = newToken(); sessions.set(token, {user:u, ts:Date.now()});
      json(res, 200, {token, user:u});
    });
  }
  // ---- 登录 ----
  if(req.method === "POST" && url === "/api/login"){
    return readBody(req, b => {
      const u = String(b.user||"").trim(), p = String(b.pass||"");
      const meta = users.get(u);
      if(!meta || meta.hash !== hashPass(p, meta.salt)) return json(res,401,{error:"用户名或密码错误"});
      const token = newToken(); sessions.set(token, {user:u, ts:Date.now()});
      json(res, 200, {token, user:u});
    });
  }
  // ---- 以下接口需要登录 ----
  const user = authUser(req);
  if(url.startsWith("/api/") && !user) return json(res, 401, {error:"请先登录"});

  if(req.method === "GET" && url === "/api/me"){
    return json(res, 200, {user});
  }
  if(req.method === "GET" && url === "/api/data"){
    return json(res, 200, loadData(user) || {sentences:[], errors:{}, graded:0, drills:[]});
  }
  if(req.method === "PUT" && url === "/api/data"){
    return readBody(req, b => {
      if(typeof b !== "object" || !Array.isArray(b.sentences)) return json(res,400,{error:"bad data"});
      saveData(user, b);
      json(res, 200, {ok:true});
    });
  }
  if(req.method === "POST" && url === "/api/llm"){
    return readBody(req, b => proxyLLM(req, res, b, user));
  }

  // ---- 静态文件 ----
  let file = url;
  if(file === "/" || file === "") file = "/index.html";
  const fp = path.join(__dirname, path.normalize(file).replace(/^([.][.][\\/])+/, ""));
  if(!fp.startsWith(__dirname)){ res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, buf) => {
    if(err){ res.writeHead(404); return res.end("not found"); }
    const types = {".html":"text/html; charset=utf-8", ".js":"text/javascript", ".css":"text/css", ".ico":"image/x-icon", ".png":"image/png", ".svg":"image/svg+xml"};
    res.writeHead(200, {"Content-Type": types[path.extname(fp)] || "application/octet-stream", "Cache-Control":"no-cache"});
    res.end(buf);
  });
});
server.listen(PORT, () => console.log(`✓ 英语语感训练器已启动: http://localhost:${PORT}（账号数据目录: ${DATA_DIR}）`));
