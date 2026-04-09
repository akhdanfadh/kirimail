# Kirimail Docker image — single image, CMD selects role.
#
# Web (default):  node apps/web/.output/server/index.mjs
# Workers:        node --import tsx src/standalone.ts (working_dir: apps/workers)
#
# When adding a new workspace package, update the COPY lines in the
# base stage (package.json). If workers depend on it, also add its
# src/ to the runner stage.

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
# Stage 2: build — install all deps + compile the web app
# ============================================================
FROM base AS build

# --shamefully-hoist: flatten node_modules/ so the bundler finds all deps.
#   Known compatibility gap between pnpm symlinks and Nitro-based bundling
#   in Docker: https://github.com/nuxt/nuxt/issues/14146
RUN pnpm install --frozen-lockfile --ignore-scripts --shamefully-hoist

COPY . .
RUN pnpm turbo run build --filter=@kirimail/web

# ============================================================
# Stage 3: runner — production image
# ============================================================
FROM base AS runner

ENV NODE_ENV=production

RUN pnpm install --frozen-lockfile --ignore-scripts --prod

# Built web app (Nitro server + client assets)
COPY --from=build /app/apps/web/.output ./apps/web/.output

# Worker + dependency sources (tsx transpiles at runtime).
# Workers import: db, env, mail, shared.
COPY apps/workers/src ./apps/workers/src
COPY apps/workers/tsconfig.json ./apps/workers/
COPY packages/db/src ./packages/db/src
COPY packages/env/src ./packages/env/src
COPY packages/mail/src ./packages/mail/src
COPY packages/shared/src ./packages/shared/src

RUN addgroup --system --gid 2000 kirimail \
  && adduser --system --uid 2000 --ingroup kirimail kirimail
USER kirimail

EXPOSE 3000

CMD ["node", "apps/web/.output/server/index.mjs"]
