import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { dbEnv } from "./env";
import * as schema from "./schema";

export const pool = new Pool({ connectionString: dbEnv.DATABASE_URL });
export const db = drizzle(pool, { schema });

export { applySync, type ApplySyncResult } from "./sync";
export * from "./schema";
