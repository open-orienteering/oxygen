# ─── Stage 1: Install dependencies ─────────────────────────
FROM node:20-slim AS deps

RUN npm install -g pnpm

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/

RUN pnpm install --frozen-lockfile

# Generate Prisma client (only needs the schema + installed deps)
COPY packages/api/prisma/ packages/api/prisma/
RUN pnpm --filter @oxygen/api db:generate

# ─── Stage 2: Build everything ─────────────────────────────
FROM deps AS build

COPY packages/shared/ packages/shared/
COPY packages/api/ packages/api/
COPY packages/web/ packages/web/

# Build shared first (API references it via project references)
RUN pnpm --filter @oxygen/shared build

# Build the API
RUN pnpm --filter @oxygen/api build

# Patch shared package to use compiled output (node can't import .ts)
RUN node -e "\
  const fs=require('fs');\
  const p=JSON.parse(fs.readFileSync('packages/shared/package.json'));\
  p.main='./dist/src/index.js';\
  fs.writeFileSync('packages/shared/package.json',JSON.stringify(p,null,2))"

# Build the web frontend (vite build only — skip tsc type-check for speed)
RUN cd packages/web && npx vite build

# ─── Stage 3: API production image ────────────────────────
FROM node:20-slim AS api

WORKDIR /app

# Copy the monorepo structure with deps (includes generated Prisma client)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./
COPY --from=deps /app/pnpm-workspace.yaml ./

# Copy shared package (runtime dependency for the API)
COPY --from=build /app/packages/shared/ ./packages/shared/

# Copy built API (source + compiled output + local deps)
COPY --from=build /app/packages/api/ ./packages/api/

ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0
EXPOSE 3001

CMD ["node", "packages/api/dist/index.js"]

# ─── Stage 4: Web production image (nginx) ─────────────────
FROM nginx:alpine AS web

COPY --from=build /app/packages/web/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
