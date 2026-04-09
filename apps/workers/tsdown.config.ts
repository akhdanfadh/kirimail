import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/standalone.ts"],
  target: "node24",
  deps: {
    // NOTE: Workspace packages (@kirimail/*) are in dependencies, so tsdown
    // externalizes them by default. alwaysBundle overrides this to compile
    // their raw TypeScript into the output. Their transitive npm deps
    // (pg, drizzle-orm, imapflow, etc.) get bundled along - intentional.
    // @see https://tsdown.dev/options/dependencies
    // @see https://github.com/rolldown/tsdown/issues/544
    alwaysBundle: [/^@kirimail\//],
    onlyBundle: false,
  },
});
