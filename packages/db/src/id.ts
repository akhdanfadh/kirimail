import { nanoid } from "nanoid";

/** Generate a nanoid for use as a table primary key. */
export function generateId(): string {
  return nanoid();
}
