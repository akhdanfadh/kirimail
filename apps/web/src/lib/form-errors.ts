/**
 * Returns a display-safe first validation error message from TanStack Form metadata.
 */
export function getFirstErrorMessage(errors: unknown[]): string | null {
  const firstError = errors[0];

  if (!firstError) {
    return null;
  }

  if (typeof firstError === "string") {
    return firstError;
  }

  if (
    typeof firstError === "object" &&
    firstError !== null &&
    "message" in firstError &&
    typeof firstError.message === "string"
  ) {
    return firstError.message;
  }

  return null;
}
