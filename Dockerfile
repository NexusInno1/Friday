# ==========================================
# Stage 1: Build & Compile TypeScript
# ==========================================
FROM node:22-alpine AS builder

WORKDIR /app

# Install all dependencies (including devDependencies for TypeScript compilation)
COPY package*.json tsconfig*.json ./
RUN npm ci

# Copy source code and compile production bundle
COPY src ./src
RUN npm run build

# ==========================================
# Stage 2: Production Lean Runner
# ==========================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Install production dependencies only and clear cache
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy compiled JavaScript output from builder stage
COPY --from=builder /app/dist ./dist

# Security hardening: Run as unprivileged node user
RUN chown -R node:node /app
USER node

EXPOSE 8080

# Docker Healthcheck against the /health fast liveness endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT:-8080}/health || exit 1

# Start FRIDAY
CMD ["node", "dist/index.js"]
