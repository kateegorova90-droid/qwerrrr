/**
 * Wildberries API Proxy Server
 * Решает CORS-проблему: принимает запросы от браузера,
 * проксирует к WB API с токеном авторизации.
 *
 * Установка:  npm install
 * Запуск:     node server.js
 * Деплой:     Railway / Render / Vercel (инструкция в README.md)
 */

// Загрузка .env вручную (без npm-пакета dotenv)
const fs = require("fs");
try {
  const env = fs.readFileSync(".env", "utf8");
  env.split("\n").forEach((line) => {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) return;
    const idx = clean.indexOf("=");
    if (idx < 0) return;
    const key = clean.slice(0, idx).trim();
    const val = clean.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  });
} catch { /* .env не найден — используем переменные окружения */ }

const http = require("http");
const https = require("https");
const url = require("url");

const PORT = process.env.PORT || 3000;
const WB_TOKEN = process.env.WB_TOKEN || "";

// Простой in-memory кэш (TTL в секундах)
const cache = new Map();
function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data, ttlSec = 300) {
  cache.set(key, { data, expires: Date.now() + ttlSec * 1000 });
}

// Открытый CORS — токен хранится на сервере, поэтому это безопасно
const ALLOWED_ORIGINS = "*";

// ─── Маршруты ────────────────────────────────────────────────────────────────
const ROUTES = {

  // Статистика заказов
  // GET /api/orders?dateFrom=2026-05-01
  "GET /api/orders": {
    ttl: 300,
    handler: (q) => wbFetch(
      "statistics-api.wildberries.ru",
      `/api/v1/supplier/orders?dateFrom=${q.dateFrom || today()}&flag=${q.flag || 1}`
    ),
  },

  // Статистика продаж
  // GET /api/sales?dateFrom=2026-05-01
  "GET /api/sales": {
    ttl: 300,
    handler: (q) => wbFetch(
      "statistics-api.wildberries.ru",
      `/api/v1/supplier/sales?dateFrom=${q.dateFrom || today()}&flag=${q.flag || 1}`
    ),
  },

  // Отчёт о реализации (детальные продажи)
  // GET /api/reportDetailByPeriod?dateFrom=2026-05-01&dateTo=2026-05-31
  "GET /api/reportDetailByPeriod": {
    ttl: 600,
    handler: (q) => wbFetch(
      "statistics-api.wildberries.ru",
      `/api/v5/supplier/reportDetailByPeriod?dateFrom=${q.dateFrom || monthStart()}&dateTo=${q.dateTo || today()}&limit=${q.limit || 100000}&rrdid=${q.rrdid || 0}`
    ),
  },

  // Склады — остатки товаров
  // GET /api/stocks?dateFrom=2026-05-01
  "GET /api/stocks": {
    ttl: 300,
    handler: (q) => wbFetch(
      "statistics-api.wildberries.ru",
      `/api/v1/supplier/stocks?dateFrom=${q.dateFrom || today()}`
    ),
  },

  // Список рекламных кампаний
  // GET /api/adv/campaigns?status=9&type=8
  // status: 7=запущена, 9=активна, 11=пауза; type: 8=автомат, 9=аукцион
  "GET /api/adv/campaigns": {
    ttl: 120,
    handler: (q) => wbFetch(
      "advert-api.wb.ru",
      `/adv/v1/promotion/count?status=${q.status || ""}&type=${q.type || ""}`
    ),
  },

  // Расходы на рекламу по дням
  // GET /api/adv/costs?from=2026-05-01&to=2026-05-31
  "GET /api/adv/costs": {
    ttl: 300,
    handler: (q) => wbFetch(
      "advert-api.wb.ru",
      `/adv/v1/upd?from=${q.from || monthStart()}&to=${q.to || today()}`
    ),
  },

  // Полная статистика кампаний (ДРР, показы, клики, расходы)
  // POST /api/adv/fullstats  body: { "ids": [12345, 67890] }
  "POST /api/adv/fullstats": {
    ttl: 300,
    handler: (q, body) => wbFetch(
      "advert-api.wb.ru",
      "/adv/v2/fullstats",
      "POST",
      body
    ),
  },

  // Баланс рекламного кабинета
  // GET /api/adv/balance
  "GET /api/adv/balance": {
    ttl: 60,
    handler: () => wbFetch("advert-api.wb.ru", "/adv/v1/balance"),
  },

  // Ключевые слова и ставки
  // GET /api/adv/keywords?campaignId=12345
  "GET /api/adv/keywords": {
    ttl: 120,
    handler: (q) => wbFetch(
      "advert-api.wb.ru",
      `/adv/v1/stat/words?id=${q.campaignId}`
    ),
  },

  // Аналитика поисковых запросов
  // GET /api/analytics/search?period=week
  "GET /api/analytics/search": {
    ttl: 3600,
    handler: (q) => wbFetch(
      "seller-analytics-api.wildberries.ru",
      `/api/v2/nm-report/detail?period=${q.period || "week"}`
    ),
  },

  // Воронка продаж / конверсия
  // GET /api/analytics/funnel?nmIDs=12345,67890&period=week
  "GET /api/analytics/funnel": {
    ttl: 3600,
    handler: (q) => wbFetch(
      "seller-analytics-api.wildberries.ru",
      `/api/v2/nm-report/detail?nmIDs=${q.nmIDs}&period=${q.period || "week"}`
    ),
  },

  // Внешний трафик (UTM-метки)
  // GET /api/analytics/external?dateFrom=2026-05-01&dateTo=2026-05-31
  "GET /api/analytics/external": {
    ttl: 600,
    handler: (q) => wbFetch(
      "seller-analytics-api.wildberries.ru",
      `/api/v1/paid-acceptance-report?dateFrom=${q.dateFrom || monthStart()}&dateTo=${q.dateTo || today()}`
    ),
  },

  // Healthcheck
  "GET /health": {
    ttl: 0,
    handler: () => Promise.resolve({ ok: true, token: WB_TOKEN ? "set" : "missing", ts: new Date().toISOString() }),
  },
};

// ─── WB fetch helper ─────────────────────────────────────────────────────────
function wbFetch(host, path, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      path,
      method,
      headers: {
        Authorization: WB_TOKEN,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };
    if (body) {
      const bodyStr = JSON.stringify(body);
      options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ raw: data, status: res.statusCode });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(new Error("WB API timeout")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── HTTP сервер ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  const corsOrigin = "*";

  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (!WB_TOKEN && req.url !== "/health") {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "WB_TOKEN не задан. Добавьте его в .env файл." }));
  }

  const parsed = url.parse(req.url, true);
  const routeKey = `${req.method} ${parsed.pathname}`;
  const route = ROUTES[routeKey];

  if (!route) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Маршрут не найден", available: Object.keys(ROUTES) }));
  }

  try {
    const cacheKey = `${routeKey}:${req.url}`;
    let data = route.ttl > 0 ? getCache(cacheKey) : null;

    if (!data) {
      let body = null;
      if (req.method === "POST") {
        body = await readBody(req);
      }
      data = await route.handler(parsed.query, body);
      if (route.ttl > 0) setCache(cacheKey, data, route.ttl);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } catch (err) {
    console.error(`[${routeKey}] Ошибка:`, err.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Ошибка обращения к WB API", detail: err.message }));
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Невалидный JSON в теле запроса")); }
    });
    req.on("error", reject);
  });
}

// ─── Утилиты дат ─────────────────────────────────────────────────────────────
function today() {
  return new Date().toISOString().slice(0, 10);
}
function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

server.listen(PORT, () => {
  console.log(`\n✅ WB Proxy запущен на порту ${PORT}`);
  console.log(`   Токен: ${WB_TOKEN ? "✓ задан" : "✗ не задан (добавьте в .env)"}`);
  console.log(`\n📍 Доступные маршруты:`);
  Object.keys(ROUTES).forEach((r) => console.log(`   ${r}`));
  console.log(`\n   Healthcheck: http://localhost:${PORT}/health\n`);
});
