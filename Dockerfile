# syntax=docker/dockerfile:1
# EVIDIQ Operator MCP — production image (standalone Node.js server)

# ---- Builder: install deps and build TypeScript ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Runner: lean production deps + built output ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Only production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built output, libs, and public skill document
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/skill.md ./skill.md

EXPOSE 3000
CMD ["node", "dist/start-server.js"]