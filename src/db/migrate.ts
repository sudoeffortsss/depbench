/**
 * Applies db/migrations/*.sql in filename order, once each.
 *
 * The database is PGlite: real Postgres compiled to WASM, running in-process.
 * That is a deliberate choice for a benchmark. Anyone who wants to check our
 * numbers runs `npm install && npm run migrate` and has the schema, with no
 * Docker, no server, and no database to install.
 */

import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS_DIR = join(ROOT, "db", "migrations");
export const DATA_DIR = process.env.TRUTHLAG_DATA ?? join(ROOT, "data", "pgdata");

export async function openDb(dataDir: string = DATA_DIR): Promise<PGlite> {
  await mkdir(dataDir, { recursive: true });
  return new PGlite(dataDir);
}

/** True once schema_migration exists; on a fresh database it does not. */
async function migrationTableExists(db: PGlite): Promise<boolean> {
  const res = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'schema_migration'
     ) AS exists`,
  );
  return res.rows[0]?.exists ?? false;
}

async function appliedMigrations(db: PGlite): Promise<Set<string>> {
  if (!(await migrationTableExists(db))) return new Set();
  const res = await db.query<{ filename: string }>(
    `SELECT filename FROM schema_migration`,
  );
  return new Set(res.rows.map((r) => r.filename));
}

export async function migrate(db: PGlite): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const already = await appliedMigrations(db);
  const applied: string[] = [];

  for (const file of files) {
    if (already.has(file)) {
      console.log(`  skip   ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    // Each migration file wraps itself in BEGIN/COMMIT and records its own row
    // in schema_migration, so a failure leaves nothing half-applied.
    await db.exec(sql);
    console.log(`  apply  ${file}`);
    applied.push(file);
  }
  return applied;
}

async function main(): Promise<void> {
  console.log(`truthlag migrate`);
  console.log(`  data dir: ${DATA_DIR}`);
  const db = await openDb();
  try {
    const applied = await migrate(db);
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    console.log(
      `\n  ${applied.length} migration(s) applied, ${tables.rows.length} tables present:`,
    );
    for (const t of tables.rows) console.log(`    ${t.table_name}`);
  } finally {
    await db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
