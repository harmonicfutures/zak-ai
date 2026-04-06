import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["cjs"],
    dts: true,
    clean: true,
    outDir: "dist",
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["cjs"],
    outDir: "dist",
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
