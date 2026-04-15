import type { PgBoss } from "pg-boss";

import {
  db,
  findMailboxPathByRole,
  getEmailAccountById,
  listAllEmailAccountIds,
} from "@kirimail/db";
import { classifyImapError, IdleManager } from "@kirimail/mail";
import pLimit from "p-limit";

import { resolveImapCredentials } from "./credentials";

/**
 * Delay before forwarding IMAP events as sync jobs, collapsing bursts.
 *
 * 1s is functional with singletonKey dedup on the pg-boss side. A longer
 * window (2-3s) would collapse more aggressively during batch operations
 * (e.g., archiving 50 messages) with no user-visible latency cost.
 */
const DEBOUNCE_MS = 1_000;
/**
 * Max simultaneous IMAP connections during {@link IdlePool.startAll}.
 *
 * Heuristic - no provider documents a per-IP concurrent connection rate
 * limit, but opening hundreds of TLS handshakes simultaneously risks
 * triggering undocumented provider defenses or exhausting local sockets.
 */
const STARTUP_CONCURRENCY = 10;
/** Interval between reconciliation passes. */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 min

/**
 * Manages one {@link IdleManager} per active email account.
 *
 * On startup, loads all accounts from the database and opens persistent IDLE
 * connections. IMAP push events (EXISTS, EXPUNGE) are debounced and forwarded
 * as `sync-email-account` pg-boss jobs.
 *
 * Single-use: after {@link stopAll}, construct a new IdlePool to restart.
 * Internal IdleManager instances are closed and cannot be resurrected.
 *
 * NOTE: Assumes a single worker process. Multiple processes each open IDLE
 * connections for all accounts - safe (singletonKey deduplicates sync jobs)
 * but wasteful. Use `ENABLED_WORKERS` to partition when scaling horizontally.
 */
export class IdlePool {
  /** PgBoss instance used for managing job queues and worker tasks. */
  private readonly boss: PgBoss;

  // -- Account state --

  /** Running IDLE managers keyed by email account ID. */
  private readonly managers = new Map<string, IdleManager>();
  /** In-flight {@link addAccount} promises, awaited by {@link stopAll} for clean shutdown. */
  private readonly inflight = new Map<string, Promise<boolean>>();
  /**
   * Per-account counter incremented by {@link removeAccount}. An in-flight
   * {@link addAccount} snapshots the counter at start and checks after each
   * await - a mismatch means the account was removed during the handshake,
   * so the add should bail and clean up any started manager.
   */
  private readonly removeCounter = new Map<string, number>();
  /**
   * Accounts permanently excluded from IDLE.
   *
   * Populated by:
   * - IMAP auth/protocol errors at start (classified via {@link classifyImapError})
   * - Credential decryption failures (corrupted envelope, wrong key)
   * - `ReconnectionManager`'s onAuthDisabled (3-day auth circuit breaker)
   *
   * Transient IMAP errors (DNS timeout, server briefly down) and DB errors
   * are NOT added - reconcile retries those on the next pass.
   *
   * Cleared per-account via {@link clearAccountFailure} (for the future API
   * layer) and for deleted accounts during reconciliation.
   */
  private readonly failedIds = new Set<string>();

  // -- Timers --

  /** Per-account debounce timers for sync job enqueue. */
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  /** Periodic reconciliation timer started by {@link startAll}. */
  private reconcileTimer: NodeJS.Timeout | null = null;

  // -- Lifecycle flags --

  /** Set by {@link startAll} to prevent double startup. */
  private isStarted = false;
  /** Set by {@link stopAll} to prevent new work after shutdown. */
  private isStopped = false;

  constructor(boss: PgBoss) {
    this.boss = boss;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Load all email accounts, start IDLE managers, and begin periodic reconciliation.
   *
   * {@link addAccount} never rejects (errors are handled internally), so one
   * failing account doesn't prevent others from starting. Failed accounts and
   * accounts added after startup are picked up by the reconciliation loop.
   */
  async startAll(): Promise<void> {
    if (this.isStopped) throw new Error("IdlePool is stopped - construct a new instance");
    if (this.isStarted) return;
    this.isStarted = true;

    const accountIds = await listAllEmailAccountIds(db);

    if (accountIds.length === 0) {
      console.log("[idle-pool] no accounts found");
    } else {
      await this.addAccounts(accountIds);

      const started = this.managers.size;
      if (started < accountIds.length) {
        console.warn(`[idle-pool] started ${started}/${accountIds.length} IDLE connection(s)`);
      } else {
        console.log(`[idle-pool] started ${started}/${accountIds.length} IDLE connection(s)`);
      }
    }

    // Guard against stopAll() having run during addAccounts().
    if (this.isStopped) return;
    this.startReconcileTimer();
  }

  /**
   * Stop all IDLE managers and await in-flight addAccount calls.
   *
   * Flushes pending debounce timers as sync jobs before shutting down, so
   * IMAP events received in the last ~1s are not lost. The flushed jobs
   * land in the pg-boss queue before `boss.stop()` starts its graceful
   * drain, so they execute before the worker exits.
   */
  async stopAll(): Promise<void> {
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    this.isStopped = true;

    // Flush pending debounce timers as direct boss.send() calls (bypassing
    // enqueueSync's isStopped guard). This ensures IMAP events received in
    // the last ~1s land in the queue before boss.stop() drains it.
    const flushPromises: Promise<void>[] = [];
    for (const [id, timer] of this.debounceTimers) {
      clearTimeout(timer);
      flushPromises.push(
        this.boss
          .send("sync-email-account", { emailAccountId: id }, { singletonKey: id })
          .then(() => {})
          .catch((err: unknown) => console.error(`[idle-pool] flush failed for ${id}:`, err)),
      );
    }
    this.debounceTimers.clear();
    if (flushPromises.length > 0) {
      await Promise.all(flushPromises);
    }

    for (const manager of this.managers.values()) {
      try {
        manager.stop();
      } catch (err) {
        console.error("[idle-pool] error stopping manager:", err);
      }
    }
    this.managers.clear();

    // Await in-flight addAccount calls so shutdown guarantees quiescence.
    // isStopped is already true - each in-flight add will bail at its next
    // await boundary and clean up any just-started manager.
    if (this.inflight.size > 0) {
      await Promise.all(this.inflight.values());
    }
  }

  /** Number of active IDLE managers. */
  get size(): number {
    return this.managers.size;
  }

  // ---------------------------------------------------------------------------
  // Account management
  // ---------------------------------------------------------------------------

  /**
   * Start an IDLE manager for a single account.
   *
   * Returns `true` if the manager was started, `false` if skipped or failed.
   * Errors are handled internally (logged, blacklisted if permanent) - the
   * method never rejects.
   *
   * No-op if the pool is stopped or the account already has a running or
   * in-flight manager. Exposed for future API layer to call when an account
   * is connected.
   */
  async addAccount(emailAccountId: string): Promise<boolean> {
    if (this.isStopped) return false;
    if (this.managers.has(emailAccountId) || this.inflight.has(emailAccountId)) return false;
    if (this.failedIds.has(emailAccountId)) return false;

    const promise = this.doAddAccount(emailAccountId);
    this.inflight.set(emailAccountId, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(emailAccountId);
    }
  }

  /**
   * Stop and remove an IDLE manager for a single account.
   *
   * Does NOT clear {@link failedIds} - a failed account stays blacklisted
   * after removal. Use {@link clearAccountFailure} to clear failure state and
   * allow reconcile to re-add the account.
   */
  removeAccount(emailAccountId: string): void {
    // Increment so any in-flight addAccount for this ID bails.
    this.removeCounter.set(emailAccountId, (this.removeCounter.get(emailAccountId) ?? 0) + 1);

    const timer = this.debounceTimers.get(emailAccountId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(emailAccountId);
    }

    const manager = this.managers.get(emailAccountId);
    if (manager) {
      manager.stop();
      this.managers.delete(emailAccountId);
    }
  }

  /**
   * Clear failure state and remove the account so reconcile can re-add it.
   *
   * NOTE: No caller yet. Requires account health state persisted to the DB
   * so the UI can surface failures and trigger re-authentication. Add the
   * DB column and API endpoint together with this method's first caller.
   */
  clearAccountFailure(emailAccountId: string): void {
    this.failedIds.delete(emailAccountId);
    this.removeAccount(emailAccountId);
  }

  /**
   * Add multiple accounts with bounded concurrency.
   * {@link addAccount} never rejects - errors are handled internally.
   */
  private async addAccounts(ids: string[]): Promise<void> {
    const limit = pLimit(STARTUP_CONCURRENCY);
    await Promise.all(ids.map((id) => limit(() => this.addAccount(id))));
  }

  /**
   * Internal addAccount implementation - separated so the promise can
   * be tracked in {@link inflight} for clean shutdown.
   */
  private async doAddAccount(emailAccountId: string): Promise<boolean> {
    // Snapshot the counter so we can detect if removeAccount() was called
    // for this ID while we were awaiting.
    const counter = this.removeCounter.get(emailAccountId) ?? 0;

    try {
      const account = await getEmailAccountById(db, emailAccountId);
      if (!account) {
        console.warn(`[idle-pool] account ${emailAccountId} not found, skipping`);
        return false;
      }

      // NOTE: Credentials are resolved once and baked into the IdleManager.
      // Fine for password-based IMAP, but OAuth tokens (XOAUTH2) expire - the
      // reconnection manager would retry with a stale token. Revisit when OAuth
      // IMAP support is added.
      let creds;
      try {
        creds = resolveImapCredentials(account);
      } catch (err) {
        // Credential decryption is deterministic - corrupted envelope or
        // wrong key won't self-heal. Blacklist to avoid retrying every
        // reconcile pass.
        this.failedIds.add(emailAccountId);
        console.error(`[idle-pool] failed to add account ${emailAccountId}:`, err);
        return false;
      }

      // Gmail's All Mail (\All) captures all label changes - IDLE there instead
      // of INBOX. For non-Gmail accounts (or accounts not yet synced), fall back
      // to INBOX which always exists.
      // NOTE: IDLE target is derived from mailbox role. When a per-account
      // settings UI exists, replace with a dedicated column or user preference.
      // NOTE: Non-Gmail providers with server-side rules routing mail to
      // non-INBOX folders won't trigger push sync - only the cron schedule
      // covers those folders.
      const allMailPath = await findMailboxPathByRole(db, emailAccountId, "all");
      const targetMailbox = allMailPath ?? "INBOX";

      // Bail before the expensive IMAP handshake if the pool stopped or this
      // account was removed during the DB lookups above.
      if (this.isStale(emailAccountId, counter)) return false;

      const manager = new IdleManager({
        credentials: creds,
        targetMailbox,
        // NOTE: ExistsInfo (path, count) is discarded - the sync job is
        // full-account, not mailbox-scoped. Pass info.path when targeted
        // per-mailbox sync is added (requires changing the sync job schema).
        onExists: () => this.enqueueSyncDebounced(emailAccountId),
        // NOTE: ExpungeInfo (path, uid) is discarded - inline delete with
        // uid is deferred until the transactional outbox exists for
        // Meilisearch consistency. The sync pipeline handles deletions via
        // incremental UID reconciliation.
        onExpunge: () => this.enqueueSyncDebounced(emailAccountId),
        // NOTE: onFlags is intentionally not wired. The sync pipeline does not
        // propagate flag changes yet - triggering a sync on flag events would
        // run a no-op sync. Wire when flag sync is implemented.
        // onFlags: (info) => { ... },
        onReconnected: ({ missedMessages }) => {
          // Immediate - reconnect gap may have missed events, no benefit to debouncing.
          if (missedMessages) this.enqueueSync(emailAccountId);
        },
        onStatusChange: (status) => {
          // NOTE: Surface via account health state when the settings UI exists.
          console.log(`[idle-pool] account ${emailAccountId}: ${status}`);
        },
        // Re-entrant: onAuthDisabled and onProtocolError call removeAccount(),
        // which calls manager.stop() - from inside the manager's own
        // ReconnectionManager callback. Safe because stop() is synchronous
        // and idempotent (sets flags, closes socket, no async gap).
        reconnectionOptions: {
          onAuthFailure: (error) => {
            console.warn(
              `[idle-pool] account ${emailAccountId}: auth failure during reconnection:`,
              error.message,
            );
          },
          onAuthDisabled: (error) => {
            console.error(
              `[idle-pool] account ${emailAccountId}: auth disabled after prolonged failure, removing:`,
              error.message,
            );
            this.failedIds.add(emailAccountId);
            this.removeAccount(emailAccountId);
          },
          onProtocolError: (error) => {
            console.error(
              `[idle-pool] account ${emailAccountId}: non-retryable protocol error, removing:`,
              error.message,
            );
            this.failedIds.add(emailAccountId);
            this.removeAccount(emailAccountId);
          },
          onProlongedOutage: (error) => {
            console.warn(
              `[idle-pool] account ${emailAccountId}: prolonged outage, retries continuing:`,
              error.message,
            );
          },
        },
      });

      try {
        await manager.start();
      } catch (err) {
        // Classify the IMAP error to decide whether reconcile should retry.
        // Auth and protocol errors are permanent - bad credentials or
        // unsupported server won't self-heal. Transient and rate-limit
        // errors (DNS timeout, server briefly down) should be retried.
        const { category } = classifyImapError(err);
        if (category === "auth" || category === "protocol") {
          this.failedIds.add(emailAccountId);
        }
        console.error(`[idle-pool] failed to add account ${emailAccountId}:`, err);
        return false;
      }

      // Re-check after the IMAP handshake: stopAll() or removeAccount()
      // may have run while we were connecting. Clean up the just-started
      // manager rather than inserting an orphan.
      if (this.isStale(emailAccountId, counter)) {
        manager.stop();
        return false;
      }

      this.managers.set(emailAccountId, manager);
      return true;
    } catch (err) {
      // DB or other transient errors - not blacklisted, reconcile retries.
      console.error(`[idle-pool] failed to add account ${emailAccountId}:`, err);
      return false;
    }
  }

  /**
   * True if the pool is stopped or removeAccount was called for this
   * account since `counter` was captured.
   */
  private isStale(emailAccountId: string, counter: number): boolean {
    return this.isStopped || (this.removeCounter.get(emailAccountId) ?? 0) !== counter;
  }

  // ---------------------------------------------------------------------------
  // Reconciliation
  // ---------------------------------------------------------------------------

  /**
   * Schedule the next reconciliation pass after RECONCILE_INTERVAL_MS.
   *
   * Uses setTimeout-reschedule (not setInterval) so the interval is
   * measured from completion, not from start. This gives consistent
   * spacing regardless of how long a pass takes and eliminates the need
   * for a reentrancy guard.
   */
  private startReconcileTimer(): void {
    const tick = () => {
      this.reconcile()
        .catch((err: unknown) => console.error("[idle-pool] reconciliation failed:", err))
        .finally(() => {
          if (!this.isStopped) {
            this.reconcileTimer = setTimeout(tick, RECONCILE_INTERVAL_MS);
            this.reconcileTimer.unref();
          }
        });
    };
    this.reconcileTimer = setTimeout(tick, RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref();
  }

  /**
   * Sync the pool with the database: start IDLE for new accounts,
   * stop IDLE for accounts that no longer exist.
   */
  private async reconcile(): Promise<void> {
    if (this.isStopped) return;

    const accountIds = await listAllEmailAccountIds(db);
    const activeIds = new Set(accountIds);

    // Start IDLE for accounts in DB but not in pool (skip known failures)
    const toAdd = accountIds.filter(
      (id) => !this.managers.has(id) && !this.inflight.has(id) && !this.failedIds.has(id),
    );
    if (toAdd.length > 0) {
      console.log(`[idle-pool] reconcile: adding ${toAdd.length} account(s)`);
      await this.addAccounts(toAdd);
    }

    if (this.isStopped) return;

    // Stop IDLE for accounts removed from DB (snapshot to avoid
    // mutating the map during iteration)
    const toRemove = [...this.managers.keys()].filter((id) => !activeIds.has(id));
    for (const id of toRemove) {
      console.log(`[idle-pool] account ${id} no longer in DB, stopping IDLE`);
      this.removeAccount(id);
    }

    // Purge stale state for accounts no longer in DB
    for (const id of this.failedIds) {
      if (!activeIds.has(id)) this.failedIds.delete(id);
    }
    for (const id of this.removeCounter.keys()) {
      if (!activeIds.has(id)) this.removeCounter.delete(id);
    }
  }

  // ---------------------------------------------------------------------------
  // Sync enqueue
  // ---------------------------------------------------------------------------

  /**
   * Debounce rapid IMAP events (e.g., batch archive producing N EXPUNGE
   * events) into a single sync job. Combined with pg-boss's `singletonKey`
   * dedup, this minimizes redundant sync work.
   */
  private enqueueSyncDebounced(emailAccountId: string): void {
    if (this.isStopped) return;

    const existing = this.debounceTimers.get(emailAccountId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(emailAccountId);
      this.enqueueSync(emailAccountId);
    }, DEBOUNCE_MS);
    // Don't keep the Node.js event loop alive for debounce timers during shutdown.
    timer.unref();

    this.debounceTimers.set(emailAccountId, timer);
  }

  /**
   * Fire-and-forget sync job enqueue. Called from IdleManager's synchronous
   * callbacks (which cannot await), so `boss.send()` is intentionally not
   * awaited - errors are caught and logged.
   */
  private enqueueSync(emailAccountId: string): void {
    if (this.isStopped) return;

    this.boss
      // NOTE: boss.send() returns null when deduplicated by singletonKey
      // (job already queued/active) - add a debug-level log when structured
      // logging is introduced.
      .send("sync-email-account", { emailAccountId }, { singletonKey: emailAccountId })
      // NOTE: Failures are logged but otherwise swallowed - the sync-scheduler
      // cron acts as a catch-up fallback. Add an error counter when
      // observability is in place.
      .catch((err: unknown) =>
        console.error(`[idle-pool] failed to enqueue sync for ${emailAccountId}:`, err),
      );
  }
}
