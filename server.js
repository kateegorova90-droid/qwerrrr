"use strict";

/**
 * Wildberries API Proxy
 * - Нет npm зависимостей (только встроенные модули Node.js)
 * - Нет url.parse (используется WHATWG URL API)
 * - Запускается напрямую через node, не через npm
 * - Слушает на 0.0.0.0 для Railway
 */

const fs   = require("fs");
const http  = require("http");
const https = require("https");

// ── .env загрузка (без dotenv пакета) ────────────────────────────────────────
try {
  const lines = fs.readFileSync(".env", "utf8").split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = val;
  }
} catch (_) { /* .env не найден — используем переменные окружения */ }

const PORT      = parseInt(process.env.PORT || "8080", 10);
const WB_TOKEN  = (process.env.WB_TOKEN || "").trim();

// ── Кэш ──────────────────────────────────────────────────────────────────────
const _cache = new Map();

// ── Очередь запросов к WB (предотвращает burst 429) ──────────────────────────
let _queue = Promise.resolve();
function queuedWbReq(hostname, path, method, body) {
  _queue = _queue.then(() =>
    new Promise(resolve => setTimeout(resolve, 400))
  ).then(() => wbReq(hostname, path, method, body));
  return _queue;
}
function cacheGet(k) {
  const e = _cache.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) { _cache.delete(k); return null; }
  return e.v;
}
function cacheSet(k, v, ttlSec) {
  _cache.set(k, { v, exp: Date.now() + ttlSec * 1000 });
}

// ── WB HTTPS запрос ───────────────────────────────────────────────────────────
function wbReq(hostname, path, method, body, attempt) {
  attempt = attempt || 1;
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname,
      path,
      method:  method || "GET",
      timeout: 25000,
      headers: {
        Authorization:   WB_TOKEN,
        "Content-Type":  "application/json",
        Accept:          "application/json",
      },
    };
    if (payload) options.headers["Content-Length"] = Buffer.byteLength(payload);

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data",  (c) => chunks.push(c));
      res.on("end",   () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try   { parsed = JSON.parse(raw); }
        catch { parsed = { _raw: raw.slice(0, 500), _status: res.statusCode }; }

        if (res.statusCode === 429 && attempt <= 3) {
          const rawRetry = parseInt(res.headers["x-ratelimit-retry"] || res.headers["retry-after"] || "5", 10);
          const retryAfter = Math.min(rawRetry, 30); // максимум 30 секунд ожидания
          if (rawRetry > 30) {
            // WB говорит ждать слишком долго — токен временно заблокирован
            console.log(`[WB] 429 ${hostname}${path} — Retry-After ${rawRetry}s (>30s, не ждём)`);
            resolve({ _wb429: true, _retryAfter: rawRetry, _msg: "WB rate limit exceeded, try again later" });
            return;
          }
          const wait = retryAfter * 1000;
          console.log(`[WB] 429 ${hostname}${path} — retry ${attempt} через ${retryAfter}s`);
          setTimeout(() => {
            wbReq(hostname, path, method, body, attempt + 1).then(resolve).catch(reject);
          }, wait);
          return;
        }

        if (res.statusCode >= 400) {
          console.error(`[WB] HTTP ${res.statusCode} ${hostname}${path}:`, raw.slice(0, 200));
        }
        resolve(parsed);
      });
      res.on("error", reject);
    });

    req.on("timeout", () => req.destroy(new Error("WB API timeout")));
    req.on("error", (err) => {
      if (attempt <= 3) {
        setTimeout(() => {
          wbReq(hostname, path, method, body, attempt + 1).then(resolve).catch(reject);
        }, 3000 * attempt);
      } else {
        reject(err);
      }
    });
    if (payload) req.write(payload);
    req.end();
  });
}


// ── Утилиты ───────────────────────────────────────────────────────────────────
function today()     { return new Date().toISOString().slice(0, 10); }
function daysAgo(n)  {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ── Маршруты ──────────────────────────────────────────────────────────────────
// key: "METHOD /path"  →  { ttl, fn(query, body) }
const ROUTES = {

  "GET /health": {
    ttl: 0,
    fn:  () => Promise.resolve({
      ok:    true,
      token: WB_TOKEN ? "set" : "missing",
      ts:    new Date().toISOString(),
    }),
  },

  // Статистика заказов
  // ?dateFrom=YYYY-MM-DD
  "GET /api/orders": {
    ttl: 900,
    fn:  (q) => queuedWbReq(
      "statistics-api.wildberries.ru",
      `/api/v1/supplier/orders?dateFrom=${q.dateFrom || daysAgo(30)}&flag=1`
    ),
  },

  // Статистика продаж (выкупы)
  // ?dateFrom=YYYY-MM-DD
  "GET /api/sales": {
    ttl: 900,
    fn:  (q) => queuedWbReq(
      "statistics-api.wildberries.ru",
      `/api/v1/supplier/sales?dateFrom=${q.dateFrom || daysAgo(30)}&flag=1`
    ),
  },

  // Остатки на складах
  // ?dateFrom=YYYY-MM-DD
  "GET /api/stocks": {
    ttl: 300,
    fn:  (q) => queuedWbReq(
      "statistics-api.wildberries.ru",
      `/api/v1/supplier/stocks?dateFrom=${q.dateFrom || today()}`
    ),
  },

  // Детальный отчёт реализации
  // ?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
  "GET /api/reportDetailByPeriod": {
    ttl: 1800,
    fn:  (q) => queuedWbReq(
      "statistics-api.wildberries.ru",
      `/api/v5/supplier/reportDetailByPeriod?dateFrom=${q.dateFrom || daysAgo(30)}&dateTo=${q.dateTo || today()}&limit=100000&rrdid=0`
    ),
  },

  // Список рекламных кампаний
  // ?status=7&type=8  (status: 7=идёт, 9=активна, 11=пауза; type: 8=авто, 9=аукцион)
  "GET /api/adv/campaigns": {
    ttl: 120,
    fn:  (q) => queuedWbReq(
      "advert-api.wildberries.ru",
      `/adv/v1/promotion/count?status=${q.status || ""}&type=${q.type || ""}`
    ),
  },

  // Расходы на рекламу по дням
  // ?from=YYYY-MM-DD&to=YYYY-MM-DD
  "GET /api/adv/costs": {
    ttl: 300,
    fn:  (q) => queuedWbReq(
      "advert-api.wildberries.ru",
      `/adv/v1/upd?from=${q.from || daysAgo(30)}&to=${q.to || today()}`
    ),
  },

  // Полная статистика кампаний
  // POST body: { "ids": [12345, 67890] }
  "POST /api/adv/fullstats": {
    ttl: 300,
    fn:  (q, body) => queuedWbReq("advert-api.wildberries.ru", "/adv/v2/fullstats", "POST", body),
  },

  // Баланс рекламного кабинета
  "GET /api/adv/balance": {
    ttl: 60,
    fn:  () => queuedWbReq("advert-api.wildberries.ru", "/adv/v1/balance"),
  },

  // Ключевые слова кампании
  // ?campaignId=12345
  "GET /api/adv/keywords": {
    ttl: 120,
    fn:  (q) => queuedWbReq(
      "advert-api.wildberries.ru",
      `/adv/v1/stat/words?id=${q.campaignId || ""}`
    ),
  },

  // Аналитика поисковых запросов
  // ?period=week|month
  "GET /api/analytics/search": {
    ttl: 3600,
    fn:  (q) => queuedWbReq(
      "seller-analytics-api.wildberries.ru",
      `/api/v2/nm-report/detail?period=${q.period || "week"}`
    ),
  },

  // Воронка конверсии по артикулам
  // ?nmIDs=111,222&period=week
  "GET /api/analytics/funnel": {
    ttl: 3600,
    fn:  (q) => queuedWbReq(
      "seller-analytics-api.wildberries.ru",
      `/api/v2/nm-report/detail?nmIDs=${q.nmIDs || ""}&period=${q.period || "week"}`
    ),
  },

  // Внешний трафик
  // ?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
  "GET /api/analytics/external": {
    ttl: 600,
    fn:  (q) => queuedWbReq(
      "seller-analytics-api.wildberries.ru",
      `/api/v1/paid-acceptance-report?dateFrom=${q.dateFrom || daysAgo(30)}&dateTo=${q.dateTo || today()}`
    ),
  },
};

// ── Body reader ───────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data",  (c) => chunks.push(c));
    req.on("end",   () => {
      try {
        const s = Buffer.concat(chunks).toString("utf8");
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ── HTTP сервер ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {

  // CORS — открытый, токен на сервере
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Парс URL через WHATWG (без url.parse)
  let pathname, searchParams;
  try {
    const u   = new URL(req.url, `http://localhost:${PORT}`);
    pathname  = u.pathname;
    searchParams = u.searchParams;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Bad URL" }));
  }

  const routeKey = `${req.method} ${pathname}`;
  const route    = ROUTES[routeKey];

  if (!route) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      error:  "Route not found",
      routes: Object.keys(ROUTES),
    }));
  }

  // Токен обязателен для всех роутов кроме /health
  if (!WB_TOKEN && pathname !== "/health") {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      error: "WB_TOKEN не задан. Добавьте переменную окружения WB_TOKEN в Railway.",
    }));
  }

  const query    = Object.fromEntries(searchParams.entries());
  const cacheKey = routeKey + "|" + searchParams.toString();
  const cached   = route.ttl > 0 ? cacheGet(cacheKey) : null;

  if (cached) {
    res.writeHead(200, { "Content-Type": "application/json", "X-Cache": "HIT" });
    return res.end(JSON.stringify(cached));
  }

  try {
    const body = (req.method === "POST") ? await readBody(req) : null;
    
    const data = await route.fn(query, body);
    
    if (route.ttl > 0) cacheSet(cacheKey, data, route.ttl);
    res.writeHead(200, { "Content-Type": "application/json", "X-Cache": "MISS" });
    res.end(JSON.stringify(data));
  } catch (err) {
    console.error(`[ERROR] ${routeKey} — ${err.message}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout   = 66000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[WB-PROXY] Listening on 0.0.0.0:${PORT}`);
  console.log(`[WB-PROXY] Token: ${WB_TOKEN ? "SET ✓" : "MISSING ✗"}`);
  console.log(`[WB-PROXY] Routes: ${Object.keys(ROUTES).join(", ")}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(sig) {
  console.log(`[WB-PROXY] ${sig} received — shutting down`);
  server.close(() => {
    console.log("[WB-PROXY] Server closed");
    process.exit(0);
  });
  // Force-kill после 10 сек если сервер не закрылся
  setTimeout(() => process.exit(1), 10000).unref();
}

setInterval(() => {
  const req = https.request({ hostname: 'qwerrrr-production.up.railway.app', path: '/health', method: 'GET' }, (r) => { r.resume(); });
  req.on('error', () => {});
  req.end();
}, 10 * 60 * 1000);

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("uncaughtException",  (e) => console.error("[UNCAUGHT]", e.message));
process.on("unhandledRejection", (r) => console.error("[UNHANDLED]", r));
