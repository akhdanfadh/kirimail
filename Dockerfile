# Kirimail Docker image — single image, CMD selects role.
#
# Web (default):  node apps/web/.output/server/index.mjs
# Workers:        node apps/workers/dist/standalone.mjs
#
# When adding a new workspace package, update the COPY lines
# in the base stage (package.json).

# ============================================================
# Stage 1: base — Node.js with pnpm + workspace manifests
# ============================================================
FROM node:24-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g corepack@0.34.6 && corepack enable
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/workers/package.json ./apps/workers/
COPY packages/api/package.json ./packages/api/
COPY packages/auth/package.json ./packages/auth/
COPY packages/db/package.json ./packages/db/
COPY packages/env/package.json ./packages/env/
COPY packages/mail/package.json ./packages/mail/
COPY packages/shared/package.json ./packages/shared/

# ============================================================
# Stage 2: build — install all deps + compile web + workers
# ============================================================
FROM base AS build

# --shamefully-hoist: flatten node_modules/ so the bundler finds all deps.
#   Known compatibility gap between pnpm symlinks and Nitro-based bundling
#   in Docker: https://github.com/nuxt/nuxt/issues/14146
RUN pnpm install --frozen-lockfile --ignore-scripts --shamefully-hoist

COPY . .
RUN pnpm turbo run build --filter=@kirimail/web --filter=@kirimail/workers

# ============================================================
# Stage 3: runner — production image
# ============================================================
FROM base AS runner

ENV NODE_ENV=production

RUN pnpm install --frozen-lockfile --ignore-scripts --prod

# Built web app (Nitro server + client assets)
COPY --from=build /app/apps/web/.output ./apps/web/.output

# Built workers (tsdown bundle — workspace packages inlined)
COPY --from=build /app/apps/workers/dist ./apps/workers/dist

RUN addgroup --system --gid 2000 kirimail \
  && adduser --system --uid 2000 --ingroup kirimail kirimail
USER kirimail

EXPOSE 3000

CMD ["node", "apps/web/.output/server/index.mjs"]
