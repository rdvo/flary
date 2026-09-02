import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { organization as organizationPlugin } from "better-auth/plugins";
import { createDb } from "./db";
import { schema } from "./db/schema";
import type { Env } from "./env";

export function createAuth(env: Env, requestOrigin?: string) {
  const localOrigin =
    requestOrigin?.startsWith("http://localhost:") ||
    requestOrigin?.startsWith("http://127.0.0.1:");
  const baseURL = (localOrigin ? requestOrigin : env.APP_URL) ?? env.APP_URL;
  const socialProviders =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
          },
        }
      : undefined;

  return betterAuth({
    appName: "Flary",
    baseURL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: Array.from(
      new Set([env.APP_URL, baseURL, "http://localhost:5173", "http://127.0.0.1:5173"]),
    ),
    database: drizzleAdapter(createDb(env.DB), {
      provider: "sqlite",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      minPasswordLength: 10,
    },
    socialProviders,
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5,
      },
    },
    advanced: {
      useSecureCookies: baseURL.startsWith("https://"),
      cookiePrefix: "flary",
    },
    plugins: [
      organizationPlugin({
        creatorRole: "owner",
      }),
    ],
  });
}

export type FlaryAuth = ReturnType<typeof createAuth>;
