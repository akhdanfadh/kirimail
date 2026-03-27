import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db } from "@inbok/db";
import { betterAuth } from "better-auth";
import { serverEnv } from "./env";

export const auth = betterAuth({
  appName: "Inbok",
  baseURL: serverEnv.BETTER_AUTH_URL,
  basePath: "/api/v1/auth",
  secret: serverEnv.BETTER_AUTH_SECRET,
  trustedOrigins: [serverEnv.BETTER_AUTH_URL],
  database: drizzleAdapter(db, {
    provider: "pg",
    usePlural: true,
  }),
  emailAndPassword: {
    enabled: true,
  },
});
