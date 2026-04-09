import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/standalone.ts"],
  target: "node24",
  deps: {
    // Workers is a deployed application, not a library. Bundle all deps
    // (workspace + npm) so the production image needs no node_modules.
    // tsdown externalizes `dependencies` by default (library convention);
    // alwaysBundle overrides this for every package.
    // @see https://tsdown.dev/options/dependencies
    alwaysBundle: [/./],
    onlyBundle: false,
  },
});
