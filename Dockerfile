FROM node:20-alpine

# Рабочая директория
WORKDIR /app

# Копируем только server.js — нет зависимостей, нет npm install
COPY server.js .

# Порт (Railway передаёт через $PORT)
EXPOSE 8080

# Запускаем НАПРЯМУЮ через node, НЕ через npm
# npm start не передаёт SIGTERM в Node.js корректно
CMD ["node", "server.js"]
