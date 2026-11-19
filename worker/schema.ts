import init from '../migrations/0001_init.sql';
import setup from '../migrations/0002_setup.sql';

/* The Worker applies migrations/ itself, so an install made with the Deploy to Cloudflare button (which does not run
 * migrations) works on its first request, and nobody has to run a schema step. The files in migrations/ are the only copy
 * of the schema. Applied names go in `d1_migrations`, the table and shape `wrangler d1 migrations apply` uses, so the two
 * never apply a file twice. Add a new file here, in order, when you add one to migrations/. Statements end with `;` at the
 * end of a line, and `--` comments are whole lines. */
const MIGRATIONS: [name: string, sql: string][] = [['0001_init.sql', init], ['0002_setup.sql', setup]];

const statements = (sql: string) => sql.split('\n').filter(line => !/^\s*--/.test(line)).join('\n').split(/;\s*(?:\n|$)/).map(part => part.trim()).filter(Boolean);

async function applied(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`).run();
  return new Set((await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()).results.map(row => row.name));
}

async function migrate(db: D1Database) {
  let done = await applied(db);
  for (const [name, sql] of MIGRATIONS) {
    if (done.has(name)) continue;
    // One transaction per file. If another request applied it first, this one fails or changes nothing; re-reading settles it.
    try { await db.batch([...statements(sql).map(text => db.prepare(text)), db.prepare('INSERT OR IGNORE INTO d1_migrations(name) VALUES(?1)').bind(name)]); }
    catch (error) { done = await applied(db); if (!done.has(name)) throw error; }
  }
}

let ready: Promise<void> | null = null;
/** Brings the database up to date once per Worker instance; a failure is retried on the next request. */
export function ensureSchema(db: D1Database) {
  ready ??= migrate(db).catch(error => { ready = null; throw error; });
  return ready;
}
