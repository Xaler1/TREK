# Stage 1: React Client bauen
FROM node:22-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Produktions-Server
FROM node:22-alpine

WORKDIR /app

# Server-Dependencies installieren (better-sqlite3 braucht Build-Tools)
COPY server/package*.json ./
RUN apk add --no-cache python3 make g++ && \
    npm ci --production && \
    apk del python3 make g++

# Server-Code kopieren
COPY server/ ./

# Gebauten Client kopieren
COPY --from=client-builder /app/client/dist ./public

# Fonts für PDF-Export kopieren
COPY --from=client-builder /app/client/public/fonts ./public/fonts

# Verzeichnisse erstellen + Symlink für Abwärtskompatibilität (alte docker-compose mounten nach /app/server/uploads)
RUN mkdir -p /app/server

# Entrypoint: symlink data dirs to persistent volume at runtime
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Umgebung setzen
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "--import", "tsx", "src/index.ts"]
