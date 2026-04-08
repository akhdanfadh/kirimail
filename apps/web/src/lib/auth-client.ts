import { AUTH_BASE_PATH } from "@kirimail/auth/client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  basePath: AUTH_BASE_PATH,
});
