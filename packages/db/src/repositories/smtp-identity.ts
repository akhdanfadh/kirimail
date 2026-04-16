import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { eq } from "drizzle-orm";

import type * as schema from "../schema";

import { smtpIdentities } from "../schema";

type Db = NodePgDatabase<typeof schema>;

/** Fetch a single SMTP identity by ID. */
export async function getSmtpIdentityById(db: Db, id: string) {
  const [row] = await db.select().from(smtpIdentities).where(eq(smtpIdentities.id, id));
  return row;
}
