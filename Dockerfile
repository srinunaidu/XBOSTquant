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
# Buy Only tab runs the Python engine server-side (buyonly_api.js spawns
# `python3 -m xbost_option_discovery.run_buyonly`), so the image needs a real
# interpreter plus pandas/numpy. (--break-system-packages is required for pip
# on Debian 12+ base images.)
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && pip install --break-system-packages --no-cache-dir pandas numpy
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js buyonly_api.js buyonly_fake.js ./
COPY xbost_option_discovery/ ./xbost_option_discovery/
COPY public/ ./public/
COPY --from=webbuild /app/web/dist ./web/dist
# NOTE: mount your 1-min CSV at /app/public/HDFCBANK_minute.csv (or upload via UI)
EXPOSE 8901
ENV PORT=8901
CMD ["node", "server.js"]
