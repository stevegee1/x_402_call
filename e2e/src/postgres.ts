import pg from "pg";

export interface Database {
  url: string;
  drop(): Promise<void>;
}

const withDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

/**
 * A fresh, empty database for one e2e run. The gateways migrate it themselves on boot, exactly as
 * in production.
 *   TEST_PG_URL=postgres://user@host:port/postgres   use an existing server (local runs without Docker)
 *   unset                                            start postgres:16-alpine with Testcontainers (CI)
 */
export async function createDatabase(): Promise<Database> {
  let adminUrl = process.env.TEST_PG_URL;
  let stopContainer: (() => Promise<unknown>) | undefined;
  if (!adminUrl) {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const container = await new PostgreSqlContainer("postgres:16-alpine").start();
    adminUrl = container.getConnectionUri();
    stopContainer = () => container.stop();
  }

  const name = `e2e_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }

  return {
    url: withDb(adminUrl, name),
    async drop() {
      if (stopContainer) return void (await stopContainer());
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query(`drop database if exists ${name} with (force)`);
      } finally {
        await c.end();
      }
    },
  };
}
