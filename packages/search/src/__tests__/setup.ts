import type { StartedTestContainer } from "testcontainers";
import type { TestProject } from "vitest/node";

import { GenericContainer, Wait } from "testcontainers";

const MASTER_KEY = "kirimail-test-master-key-1234";

declare module "vitest" {
  export interface ProvidedContext {
    meilisearchUrl: string;
    meiliMasterKey: string;
  }
}

let container: StartedTestContainer;

/**
 * Boot one shared Meilisearch container for the whole test run. Per-worker
 * isolation is provided by giving each pid its own index uid in `setup-env.ts`
 * rather than its own container - Meilisearch index creation is cheap and
 * avoids spawning N containers for N vitest workers.
 */
export async function setup(project: TestProject) {
  container = await new GenericContainer("getmeili/meilisearch:v1.42.1")
    .withExposedPorts(7700)
    .withEnvironment({
      MEILI_MASTER_KEY: MASTER_KEY,
      MEILI_ENV: "development",
      MEILI_NO_ANALYTICS: "true",
    })
    .withWaitStrategy(Wait.forHttp("/health", 7700).forStatusCode(200).withStartupTimeout(60_000))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(7700);

  project.provide("meilisearchUrl", `http://${host}:${port}`);
  project.provide("meiliMasterKey", MASTER_KEY);
}

export async function teardown() {
  await container?.stop();
}
