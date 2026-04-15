import type { StartedTestContainer } from "testcontainers";
import type { TestProject } from "vitest/node";

import { pushSchema } from "drizzle-kit/api";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { GenericContainer, Wait } from "testcontainers";

import * as schema from "../schema";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedTestContainer;

/** Start a Postgres container and push the Drizzle schema into it. */
export async function setup(project: TestProject) {
  container = await new GenericContainer("postgres:18-alpine")
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_DB: "kirimail_test",
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
    })
    .withHealthCheck({
      test: ["CMD-SHELL", "pg_isready -U test"],
      interval: 500,
      timeout: 3_000,
      retries: 60,
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const databaseUrl = `postgresql://test:test@${host}:${port}/kirimail_test`;

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  const { apply } = await pushSchema(schema, db);
  await apply();
  await pool.end();

  project.provide("databaseUrl", databaseUrl);
}

/** Stop the Postgres container after all tests complete. */
export async function teardown() {
  await container?.stop();
}
