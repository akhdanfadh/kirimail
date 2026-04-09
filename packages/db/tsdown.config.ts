import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/migrate.ts"],
  target: "node24",
  deps: {
    // Deployed as a standalone script - bundle all deps so the production
    // image needs no node_modules. Same pattern as apps/workers.
    // @see https://tsdown.dev/options/dependencies
    alwaysBundle: [/./],
    onlyBundle: false,
  },
});
