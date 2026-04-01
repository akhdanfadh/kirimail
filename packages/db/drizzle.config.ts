import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const rootEnvPath = resolve(currentDir, "../../.env");
loadEnv({ path: rootEnvPath });

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

// TODO: Switch to Option 3 (generate + migrate) for first public release.
// Currently using migration Option 2 (db:push) for frictionless dev mode.
// See: https://orm.drizzle.team/docs/migrations
export default defineConfig({
  schema: "./src/schema",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl },
});
