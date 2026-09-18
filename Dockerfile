FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public/ ./public/
# NOTE: mount your 1-min CSV at /app/public/HDFCBANK_minute.csv (or upload via UI)
EXPOSE 8901
ENV PORT=8901
CMD ["node", "server.js"]
