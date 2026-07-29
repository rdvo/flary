import { drizzle } from "drizzle-orm/d1";
import { schema } from "./schema";

export const createDb = (database: D1Database) =>
  drizzle(database, {
    schema,
    logger: false,
  });

export type Database = ReturnType<typeof createDb>;
