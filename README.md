# WB Proxy — прокси-сервер для Wildberries API

Решает CORS-проблему: принимает запросы от браузера (агент на claude.ai),
перенаправляет их к WB API с вашим токеном авторизации.

---

## Быстрый старт

### 1. Получить токен WB

1. Войдите в [Личный кабинет WB](https://seller.wildberries.ru)
2. Настройки → Доступ к API → Создать новый токен
3. Включите разрешения: **Статистика**, **Реклама**, **Аналитика**
4. Скопируйте токен (он показывается один раз!)

### 2. Запустить локально

```bash
git clone <этот репозиторий>
cd wb-proxy

# Создать .env
cp .env.example .env
# Откройте .env и вставьте ваш токен

# Установить зависимости
npm install

# Запустить
npm start
# Сервер стартует на http://localhost:3000
```

Проверьте: откройте `http://localhost:3000/health` — должно вернуться `{"ok":true}`.

---

## Деплой на Railway (бесплатно)

Railway даёт бесплатный хостинг — идеально для прокси.

1. Зарегистрируйтесь на [railway.app](https://railway.app)
2. Нажмите **New Project → Deploy from GitHub repo**
3. Загрузите папку `wb-proxy` в GitHub (или используйте Railway CLI)
4. В настройках проекта: **Variables** → добавьте `WB_TOKEN=ваш_токен`
5. Railway автоматически запустит сервер
6. Скопируйте URL вида `https://wb-proxy-production-xxxx.up.railway.app`

---

## Деплой на Render (альтернатива)

1. Зарегистрируйтесь на [render.com](https://render.com)
2. New → Web Service → Connect GitHub repo
3. Environment Variables → добавьте `WB_TOKEN`
4. Нажмите **Deploy** — Render сам установит зависимости и запустит

---

## Доступные маршруты

| Метод | Путь | Параметры | Описание |
|-------|------|-----------|----------|
| GET | `/health` | — | Проверка работы сервера |
| GET | `/api/orders` | `dateFrom` | Заказы |
| GET | `/api/sales` | `dateFrom` | Продажи (выкупы) |
| GET | `/api/reportDetailByPeriod` | `dateFrom`, `dateTo` | Детальный отчёт реализации |
| GET | `/api/stocks` | `dateFrom` | Остатки на складах |
| GET | `/api/adv/campaigns` | `status`, `type` | Список кампаний |
| GET | `/api/adv/costs` | `from`, `to` | Расходы на рекламу |
| POST | `/api/adv/fullstats` | body: `{ids:[...]}` | Полная статистика кампаний |
| GET | `/api/adv/balance` | — | Баланс рекламного кабинета |
| GET | `/api/adv/keywords` | `campaignId` | Ключевые слова кампании |
| GET | `/api/analytics/search` | `period` | Аналитика поисковых запросов |
| GET | `/api/analytics/funnel` | `nmIDs`, `period` | Воронка конверсии |
| GET | `/api/analytics/external` | `dateFrom`, `dateTo` | Внешний трафик |

---

## Подключить к агенту

После деплоя замените `PROXY_URL` в агенте на ваш URL:

```js
const PROXY_URL = "https://wb-proxy-production-xxxx.up.railway.app";

// Пример запроса:
const orders = await fetch(`${PROXY_URL}/api/orders?dateFrom=2026-05-01`).then(r => r.json());
```

---

## Кэширование

Все запросы кэшируются в памяти, чтобы не превысить лимиты WB API:

- Заказы/продажи: 5 минут
- Рекламные кампании: 2 минуты
- Аналитика: 1 час
- Баланс: 1 минута

---

## Структура проекта

```
wb-proxy/
├── server.js        # Основной сервер (все маршруты внутри)
├── package.json     # Зависимости
├── .env.example     # Шаблон переменных окружения
├── railway.json     # Конфиг для Railway
└── render.yaml      # Конфиг для Render
```
