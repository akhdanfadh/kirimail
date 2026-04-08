import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db } from "@kirimail/db";
import { betterAuth } from "better-auth";

import { AUTH_BASE_PATH } from "./client";
import { serverEnv } from "./env";

export { AUTH_BASE_PATH };

export const auth = betterAuth({
  appName: "Kirimail",
  baseURL: serverEnv.BETTER_AUTH_URL,
  basePath: AUTH_BASE_PATH,
  secret: serverEnv.BETTER_AUTH_SECRET,
  trustedOrigins: [serverEnv.BETTER_AUTH_URL],
  session: {
    expiresIn: 60 * 60 * 24 * 7, // default: 7d, unless used and updateAge below is reached
    updateAge: 60 * 60 * 24, // default: every 1d, the session expiration is extended per above
    freshAge: 60 * 60 * 24, // default: 1d after sign-in, critical actions require re-authentication
    cookieCache: {
      enabled: true, // enabled for reducing server load and DB calls, improving performance
      maxAge: 60 * 5, // 5m
      strategy: "jwe", // maximum security but large cookie size
      refreshCache: false, // default; no auto-refresh if cache expired
    },
  },
  advanced: {
    // useSecureCookies: true, // true in prod; commented for explicitness and ease of local development
    cookiePrefix: "kirimail",
    crossSubDomainCookies: {
      enabled: false, // default
    },
    disableCSRFCheck: false, // default
    disableOriginCheck: false, // default
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    usePlural: true,
  }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true, // default
  },
});
