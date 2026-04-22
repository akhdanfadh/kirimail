# Kirimail Docker image — single image, CMD selects role.
#
# Web (default):  node apps/web/.output/server/index.mjs
# Workers:        node apps/workers/dist/standalone.mjs
#
# When adding a new workspace package, update the COPY lines
# in the build stage (package.json).

# ============================================================
# Stage 1: build — install all deps + compile web + workers
# ============================================================
FROM node:24-slim AS build
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
COPY packages/search/package.json ./packages/search/
COPY packages/shared/package.json ./packages/shared/

# --shamefully-hoist: flatten node_modules/ so the bundler finds all deps.
#   Known compatibility gap between pnpm symlinks and Nitro-based bundling
#   in Docker: https://github.com/nuxt/nuxt/issues/14146
RUN pnpm install --frozen-lockfile --ignore-scripts --shamefully-hoist

COPY . .
RUN pnpm turbo run build --filter=@kirimail/web --filter=@kirimail/workers

# Generate migration SQL from current schema. Remove any leftover local
# drizzle/ that COPY may have included so generate always starts clean.
#
# NOTE: Pre-v1 only. Remove this line when schema stabilizes.
# Post-v1, developers run db:generate locally and commit the SQL files.
RUN rm -rf packages/db/drizzle && pnpm --filter @kirimail/db run db:generate --name=initial

# ============================================================
# Stage 2: runner — production image
# ============================================================
FROM node:24-slim AS runner

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Built web app (Nitro server + client assets)
COPY --from=build /app/apps/web/.output ./apps/web/.output

# Built workers (tsdown bundle — workspace packages inlined)
COPY --from=build /app/apps/workers/dist ./apps/workers/dist

# Migration runner + generated SQL files
COPY --from=build /app/packages/db/dist/migrate.mjs ./packages/db/dist/
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle

RUN addgroup --system --gid 2000 kirimail \
  && adduser --system --uid 2000 --ingroup kirimail kirimail
USER kirimail

EXPOSE 3000

CMD ["node", "apps/web/.output/server/index.mjs"]
