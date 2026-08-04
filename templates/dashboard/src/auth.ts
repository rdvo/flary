import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "./db/schema";
import type { Bindings } from "./flary";

export function createAuth(env: Bindings, origin: string) {
  return betterAuth({
    appName: "Flary",
    baseURL: origin,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [origin, "http://localhost:5173", "http://127.0.0.1:5173"],
    database: drizzleAdapter(drizzle(env.FLARY_DASHBOARD_DB), { provider: "sqlite", schema }),
    emailAndPassword: { enabled: true, requireEmailVerification: false, minPasswordLength: 10 },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    advanced: { useSecureCookies: origin.startsWith("https://"), cookiePrefix: "flary" },
  });
}
