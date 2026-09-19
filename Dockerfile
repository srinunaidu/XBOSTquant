# ---- web build stage (React terminal; prebuild syncs engine.js/worker.js) ----
FROM node:22-slim AS webbuild
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json ./web/
RUN npm ci
COPY . .
RUN npm run build -w web

# ---- runtime stage (server + classic terminal fallback + built React app) ----
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public/ ./public/
COPY --from=webbuild /app/web/dist ./web/dist
# NOTE: mount your 1-min CSV at /app/public/HDFCBANK_minute.csv (or upload via UI)
EXPOSE 8901
ENV PORT=8901
CMD ["node", "server.js"]
