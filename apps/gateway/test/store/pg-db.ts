import { randomBytes } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { withDb } from "./pg-url";

/** Clones the migrated template into a fresh database. Returns its URL and a drop function. */
export async function createTestDb(): Promise<{ url: string; drop: () => Promise<void> }> {
  const admin = inject("pgAdminUrl");
  const template = inject("pgTemplateDb");
  const name = `t_${randomBytes(6).toString("hex")}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  try {
    // CREATE DATABASE … TEMPLATE fails if another session is cloning the same template at that moment.
    for (let attempt = 0; ; attempt++) {
      try {
        await c.query(`create database ${name} template ${template}`);
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== "55006" || attempt >= 20) throw e;
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
      }
    }
  } finally {
    await c.end();
  }
  return {
    url: withDb(admin, name),
    drop: async () => {
      const d = new pg.Client({ connectionString: admin });
      await d.connect();
      try {
        await d.query(`drop database if exists ${name} with (force)`);
      } finally {
        await d.end();
      }
    },
  };
}
