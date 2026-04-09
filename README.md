# Kirimail

Multi-user, multi-account email client. Work in progress.

## Test things up

Prerequisites: Docker.

```bash
# Copy env and fill in BETTER_AUTH_SECRET + CREDENTIAL_ENCRYPTION_KEY
cp .env.example .env

# Build image and start all services
docker compose -f compose.build.yaml up --build
```

This starts three containers:

| Service    | Role                                   | Port |
| ---------- | -------------------------------------- | ---- |
| `web`      | Web server (TanStack Start + Hono API) | 3000 |
| `workers`  | Background jobs (pg-boss)              | -    |
| `postgres` | Database                               | 5432 |

Web and workers use the same Docker image with different commands. They communicate through Postgres.

## Development

Prerequisites: Node.js 24+, pnpm, Docker.

```bash
# Start Postgres
docker compose -f compose.dev.yaml up -d

# Copy env and fill in secrets
cp .env.example .env

# Install dependencies
pnpm install

# Push DB schema (dev only, no migrations yet)
pnpm --filter @kirimail/db run db:push

# Start web + workers in one process
pnpm dev
```

The web app runs at `http://localhost:3000`. Workers start in-process automatically.
