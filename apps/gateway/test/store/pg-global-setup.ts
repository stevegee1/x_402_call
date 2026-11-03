import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { migrate } from "../../src/store/migrate";
import { withDb } from "./pg-url";

// Same major version as production (RDS) and docker-compose.yml.
const IMAGE = "postgres:16-alpine";
const TEMPLATE_DB = `mx_template_${process.pid}`;

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgTemplateDb: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;
let adminUrl: string | undefined;

/**
 * Provides one Postgres for the whole integration run and migrates a template database.
 * Tests clone the template (CREATE DATABASE … TEMPLATE), which takes milliseconds and gives each
 * test a fully isolated schema — no truncation, so append-only triggers stay intact.
 *
 * Default: a postgres:16 container via Testcontainers. Set TEST_PG_URL to an existing server
 * (superuser or CREATEDB role) to use that instead, e.g. where Docker is unavailable.
 */
export async function setup(project: TestProject) {
  if (process.env.TEST_PG_URL) {
    adminUrl = process.env.TEST_PG_URL;
  } else {
    container = await new PostgreSqlContainer(IMAGE).withDatabase("postgres").withUsername("mx").withPassword("mx").start();
    adminUrl = container.getConnectionUri();
  }
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const v = await c.query<{ server_version: string }>("show server_version");
    console.log(`[integration] Postgres ${v.rows[0]!.server_version} (${container ? "testcontainers" : "TEST_PG_URL"})`);
    await c.query(`drop database if exists ${TEMPLATE_DB}`);
    await c.query(`create database ${TEMPLATE_DB}`);
  } finally {
    await c.end();
  }
  await migrate(withDb(adminUrl, TEMPLATE_DB), () => {});
  project.provide("pgAdminUrl", adminUrl);
  project.provide("pgTemplateDb", TEMPLATE_DB);
}

export async function teardown() {
  if (container) return void (await container.stop());
  if (!adminUrl) return;
  // External server: remove the template and any test databases left by an aborted run.
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const left = await c.query<{ datname: string }>("select datname from pg_database where datname like 't\\_%' escape '\\' and length(datname) = 14");
    for (const r of left.rows) await c.query(`drop database if exists ${r.datname} with (force)`);
    await c.query(`drop database if exists ${TEMPLATE_DB}`);
  } finally {
    await c.end();
  }
}
