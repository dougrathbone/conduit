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

# Build React renderer (→ out/renderer/) and compile TypeScript server (→ out/server/)
RUN npm run build:server

# ─── Production stage ────────────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# Runtime dependency for better-sqlite3
RUN apt-get update && \
    apt-get install -y libsqlite3-dev && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# Copy the built output from the builder stage
COPY --from=builder /app/out ./out

# /data is the persistent volume for the SQLite DB, logs, and prefs
VOLUME /data
ENV CONDUIT_DATA_DIR=/data
ENV PORT=7456

EXPOSE 7456

CMD ["node", "out/server/index.js"]
