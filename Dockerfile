# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && \
    apt-get install -y python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .

# Build React renderer → out/renderer/
RUN npx vite build --config vite.server.config.ts

# ─── Production stage ────────────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# Build tools for better-sqlite3 native module
RUN apt-get update && \
    apt-get install -y python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

# Copy TypeScript source (tsx runs TS directly — no separate compile step)
COPY src ./src
COPY tsconfig*.json ./

# Copy built frontend from builder
COPY --from=builder /app/out/renderer ./out/renderer

# /data is the persistent volume for the SQLite DB, logs, and prefs
VOLUME /data
ENV CONDUIT_DATA_DIR=/data
ENV PORT=7456

EXPOSE 7456

CMD ["npx", "tsx", "src/server/index.ts"]
