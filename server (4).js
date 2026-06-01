const fs = require("fs");
const http = require("http");
const https = require("https");

// Загрузка .env
try {
  fs.readFileSync(".env", "utf8").split("\n").forEach((line) => {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) return;
    const idx = clean.indexOf("=");
    if (idx < 0) return;
    const key = clean.slice(0, idx).trim();
    const val = clean.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  });
} catch {}

const PORT = parseInt(process.env.PORT || "8080", 10);
const WB_TOKEN = process.env.WB_TOKEN || "";

// Кэш
const cache = new Map();
function getCache(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { cache.delete(key); return null; }
  return e.data;
}
function setCache(key, data, ttl) {
  cache.set(key, { data, exp: Date.now() + ttl * 1000 });
}

// Запрос к WB API
function wbRequest(hostname, path, method, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname,
      path,
      method: method || "GET",
      headers: {
        Authorization: WB_TOKEN,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ raw, status: res.statusCode }); }
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function today() { return new Date().toISOString().slice(0, 10); }
function monthAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

// Роуты
const ROUTES = {
  "GET /health": {
    ttl: 0,
    fn: () => Promise.resolve({ ok: true, token: WB_TOKEN ? "set" : "missing", ts: new Date().toISOString() }),
  },
  "GET /api/orders": {
    ttl: 300,
    fn: (q) => wbRequest("statistics-api.wildberries.ru", `/api/v1/supplier/orders?dateFrom=${q.dateFrom || monthAgo()}&flag=1`),
  },
  "GET /api/sales": {
    ttl: 300,
    fn: (q) => wbRequest("statistics-api.wildberries.ru", `/api/v1/supplier/sales?dateFrom=${q.dateFrom || monthAgo()}&flag=1`),
  },
  "GET /api/stocks": {
    ttl: 300,
    fn: (q) => wbRequest("statistics-api.wildberries.ru", `/api/v1/supplier/stocks?dateFrom=${q.dateFrom || today()}`),
  },
  "GET /api/reportDetailByPeriod": {
    ttl: 600,
    fn: (q) => wbRequest("statistics-api.wildberries.ru", `/api/v5/supplier/reportDetailByPeriod?dateFrom=${q.dateFrom || monthAgo()}&dateTo=${q.dateTo || today()}&limit=100000&rrdid=0`),
  },
  "GET /api/adv/campaigns": {
    ttl: 120,
    fn: (q) => wbRequest("advert-api.wb.ru", `/adv/v1/promotion/count?status=${q.status || ""}&type=${q.type || ""}`),
  },
  "GET /api/adv/costs": {
    ttl: 300,
    fn: (q) => wbRequest("advert-api.wb.ru", `/adv/v1/upd?from=${q.from || monthAgo()}&to=${q.to || today()}`),
  },
  "POST /api/adv/fullstats": {
    ttl: 300,
    fn: (q, body) => wbRequest("advert-api.wb.ru", "/adv/v2/fullstats", "POST", body),
  },
  "GET /api/adv/balance": {
    ttl: 60,
    fn: () => wbRequest("advert-api.wb.ru", "/adv/v1/balance"),
  },
  "GET /api/adv/keywords": {
    ttl: 120,
    fn: (q) => wbRequest("advert-api.wb.ru", `/adv/v1/stat/words?id=${q.campaignId || ""}`),
  },
  "GET /api/analytics/search": {
    ttl: 3600,
    fn: (q) => wbRequest("seller-analytics-api.wildberries.ru", `/api/v2/nm-report/detail?period=${q.period || "week"}`),
  },
  "GET /api/analytics/funnel": {
    ttl: 3600,
    fn: (q) => wbRequest("seller-analytics-api.wildberries.ru", `/api/v2/nm-report/detail?nmIDs=${q.nmIDs || ""}&period=${q.period || "week"}`),
  },
  "GET /api/analytics/external": {
    ttl: 600,
    fn: (q) => wbRequest("seller-analytics-api.wildberries.ru", `/api/v1/paid-acceptance-report?dateFrom=${q.dateFrom || monthAgo()}&dateTo=${q.dateTo || today()}`),
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Парсим URL без url.parse
  let pathname, searchParams;
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    pathname = u.pathname;
    searchParams = u.searchParams;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "bad url" }));
  }

  const routeKey = `${req.method} ${pathname}`;
  const route = ROUTES[routeKey];

  if (!route) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "not found", routes: Object.keys(ROUTES) }));
  }

  if (!WB_TOKEN && pathname !== "/health") {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "WB_TOKEN не задан" }));
  }

  const query = Object.fromEntries(searchParams.entries());
  const cacheKey = routeKey + req.url;
  const cached = route.ttl > 0 ? getCache(cacheKey) : null;

  if (cached) {
    res.writeHead(200, { "Content-Type": "application/json", "X-Cache": "HIT" });
    return res.end(JSON.stringify(cached));
  }

  try {
    const body = req.method === "POST" ? await readBody(req) : null;
    const data = await route.fn(query, body);
    if (route.ttl > 0) setCache(cacheKey, data, route.ttl);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } catch (err) {
    console.error(routeKey, err.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`WB Proxy listening on 0.0.0.0:${PORT}`);
  console.log(`Token: ${WB_TOKEN ? "SET" : "MISSING"}`);
  console.log(`Routes: ${Object.keys(ROUTES).length}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT",  () => server.close(() => process.exit(0)));
process.on("uncaughtException",  (e) => console.error("uncaught:", e.message));
process.on("unhandledRejection", (r) => console.error("unhandled:", r));
