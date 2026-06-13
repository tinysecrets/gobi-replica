# ---- Build Stage ----
FROM node:20-slim AS builder
WORKDIR /app

# Install build deps for better-sqlite3 native module
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# Clean up build deps after npm to keep layer minimal
RUN apt-get purge -y python3 make g++ && apt-get autoremove -y

# ---- Runtime Stage ----
FROM node:20-slim AS runtime
WORKDIR /app

# Install minimal runtime deps
RUN apt-get update && apt-get install -y \
    sqlite3 \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application code
COPY . .

# Create data directories with proper permissions
RUN mkdir -p data/exports data/uploads && \
    chmod -R 755 data

# Fly.io assigns PORT env var; default to 8080
ENV PORT=8080
EXPOSE 8080

# Health check
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

CMD ["node", "src/index.js"]
