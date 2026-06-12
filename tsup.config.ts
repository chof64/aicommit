import { defineConfig } from "tsup";

export default defineConfig({
  entry: { aicommit: "src/index.ts" },
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  shims: false,
  banner: { js: "#!/usr/bin/env node" },
  minify: false,
  sourcemap: true,
});
