import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { eq, getColumns } from "drizzle-orm";

import type * as schema from "../schema";

import { emailAccounts, mailboxes, messages } from "../schema";

type Db = NodePgDatabase<typeof schema>;

/**
 * A {@link messages} row together with the account it belongs to
 * (`emailAccountId`) and the user who owns that account (`userId`).
 *
 * System-scoped, NOT an authorization check. This shape is for workers that
 * already trust the `messageId` they were given (e.g., the `message.synced`
 * dispatcher reading an id out of its own event) and need `userId` /
 * `emailAccountId` so their downstream writes land on the right tenant.
 *
 * For user-facing reads, don't call this. Use a repository function that
 * filters by the session user in its WHERE clause, so "not the session
 * user's" and "doesn't exist" both return `null`. Two failure modes if a
 * route handler uses *this* function with a post-hoc session check:
 * - Racy (TOCTOU): the session user could lose access between the fetch
 *   and the check, and the handler would still act on the stale result.
 * - Leaks existence: a missing id returns `null`; an id the session user doesn't
 *   own returns a populated row. An attacker guessing ids can tell the two apart.
 */
export interface MessageWithOwnership {
  message: typeof messages.$inferSelect;
  emailAccountId: string;
  userId: string;
}

/**
 * Fetch one message joined to its mailbox's `emailAccountId` and that
 * account's `userId`. Returns `null` when no row matches. See
 * {@link MessageWithOwnership} for the intended caller shape - this is
 * a system-scoped read, not an authorization check.
 */
export async function getMessageWithOwnership(
  db: Db,
  messageId: string,
): Promise<MessageWithOwnership | null> {
  const [row] = await db
    .select({
      message: getColumns(messages),
      emailAccountId: mailboxes.emailAccountId,
      userId: emailAccounts.userId,
    })
    .from(messages)
    .innerJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
    .innerJoin(emailAccounts, eq(mailboxes.emailAccountId, emailAccounts.id))
    .where(eq(messages.id, messageId))
    .limit(1);
  return row ?? null;
}
