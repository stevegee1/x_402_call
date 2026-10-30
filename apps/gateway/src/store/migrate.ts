import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../db/migrations");

/** Applies db/migrations/*.sql in lexical order, each in its own transaction. */
export async function migrate(databaseUrl: string, log: (m: string) => void = console.log): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(727001)");
    await client.query("create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())");
    const applied = new Set((await client.query<{ version: string }>("select version from schema_migrations")).rows.map((r) => r.version));
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
      if (applied.has(file)) continue;
      log(`applying ${file}`);
      await client.query("begin");
      try {
        await client.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
        await client.query("insert into schema_migrations (version) values ($1)", [file]);
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        throw e;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(727001)").catch(() => {});
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  await migrate(url);
  console.log("migrations complete");
}
