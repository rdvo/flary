import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" }).notNull().default(sql`(unixepoch() * 1000)`);

export const user = sqliteTable("user", {
  id: text("id").primaryKey(), name: text("name").notNull(), email: text("email").notNull(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"), createdAt: timestamp("created_at"), updatedAt: timestamp("updated_at"),
}, (table) => [uniqueIndex("user_email_unique").on(table.email)]);

export const session = sqliteTable("session", {
  id: text("id").primaryKey(), expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull(), createdAt: timestamp("created_at"), updatedAt: timestamp("updated_at"),
  ipAddress: text("ip_address"), userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
}, (table) => [uniqueIndex("session_token_unique").on(table.token), index("session_user_idx").on(table.userId)]);

export const account = sqliteTable("account", {
  id: text("id").primaryKey(), accountId: text("account_id").notNull(), providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"), refreshToken: text("refresh_token"), idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope: text("scope"), password: text("password"), createdAt: timestamp("created_at"), updatedAt: timestamp("updated_at"),
}, (table) => [index("account_user_idx").on(table.userId), uniqueIndex("account_provider_unique").on(table.providerId, table.accountId)]);

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(), identifier: text("identifier").notNull(), value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(), createdAt: timestamp("created_at"), updatedAt: timestamp("updated_at"),
}, (table) => [index("verification_identifier_idx").on(table.identifier)]);

export const schema = { user, session, account, verification };
