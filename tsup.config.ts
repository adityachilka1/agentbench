import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node22",
    platform: "node",
    sourcemap: true,
    clean: true,
    dts: true,
    shims: false,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node22",
    platform: "node",
    sourcemap: true,
    clean: false,
    dts: false,
    shims: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
