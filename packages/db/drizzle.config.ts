import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const rootEnvPath = resolve(currentDir, "../../.env");
loadEnv({ path: rootEnvPath });

const databaseUrl = process.env.DATABASE_URL?.trim();
// NOTE: Pre-v1 only. Restore this throw when generate moves out of
// Dockerfile and back to dev-time (where .env is always available).
// if (!databaseUrl) {
//   throw new Error("DATABASE_URL is not set");
// }

// NOTE: For database migration, we are currently using Option 2 (push)
// for frictionless DX and Option 3 (generate + migrate) for testing
// container deployment. Post-v1, commit to Option 3 entirely.
// @see: https://orm.drizzle.team/docs/migrations
export default defineConfig({
  schema: "./src/schema",
  dialect: "postgresql",
  out: "./drizzle",
  // NOTE: Pre-v1 only. dbCredentials is conditional because drizzle-kit
  // generate runs during Docker build where no .env is available. Post-v1,
  // replace with just: dbCredentials: { url: databaseUrl },
  ...(databaseUrl && { dbCredentials: { url: databaseUrl } }),
});
