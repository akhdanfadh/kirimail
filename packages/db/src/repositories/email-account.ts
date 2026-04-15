import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { eq } from "drizzle-orm";

import type * as schema from "../schema";

import { emailAccounts } from "../schema";

type Db = NodePgDatabase<typeof schema>;

/** Fetch a single email account by ID. */
export async function getEmailAccountById(db: Db, accountId: string) {
  const [row] = await db.select().from(emailAccounts).where(eq(emailAccounts.id, accountId));
  return row;
}

/**
 * List all email account IDs.
 *
 * NOTE: Returns every account with no active/disabled filter. Add a status
 * predicate when account deactivation or deletion states are introduced.
 */
export async function listAllEmailAccountIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: emailAccounts.id }).from(emailAccounts);
  return rows.map((r) => r.id);
}
