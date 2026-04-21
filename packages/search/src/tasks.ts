import type { EnqueuedTaskPromise, ErrorStatusCode, Task } from "meilisearch";

/** Default wait window for any single Meilisearch task. */
const DEFAULT_TASK_TIMEOUT_MS = 30_000;

/**
 * Wait for an enqueued task and throw if it didn't reach `succeeded`.
 *
 * Pass `toleratedErrorCodes` for the idempotent-failure case (e.g. createIndex
 * accepting `index_already_exists`); the caller must inspect the returned
 * `Task`'s status to branch on tolerated-vs-fresh.
 *
 * NOTE: `ErrorStatusCode` in the SDK is flagged "doesn't seem to be up to
 * date", so new Meilisearch error codes may be missing. If we ever need to
 * tolerate one the SDK hasn't listed, widen via `ErrorStatusCode | "new_code"`
 * or bump the SDK.
 */
export async function awaitTaskOrThrow(
  operation: string,
  taskPromise: EnqueuedTaskPromise,
  options?: { timeoutMs?: number; toleratedErrorCodes?: readonly ErrorStatusCode[] },
): Promise<Task> {
  const task = await taskPromise.waitTask({
    timeout: options?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
  });
  if (task.status === "succeeded") return task;
  const errorCode = task.error?.code;
  if (
    task.status === "failed" &&
    errorCode !== undefined &&
    options?.toleratedErrorCodes?.some((c) => c === errorCode)
  ) {
    return task;
  }
  throw new Error(
    `[search] ${operation} unexpected outcome: status=${task.status}, error=${errorCode ?? "none"}`,
  );
}
