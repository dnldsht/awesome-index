import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.ts";

/** kept out of git, restored from the release asset in CI */
export const DB_PATH = process.env["AWESOME_DB"] ?? "data/awesome.db";

const sqlite = new Database(DB_PATH);
// the crawler writes in long transactions while the build reads; WAL keeps the
// two from blocking each other, and is a plain win for the read-only build too
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, { schema, logger: false });
