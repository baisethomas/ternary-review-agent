import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Mirrors the `@/*` -> `./src/*` alias from tsconfig.json.
 *
 * Every module under `src/lib` is tested through a relative import and never
 * needed this. Modules under `src/app` — Server Actions in particular — import
 * their dependencies through the alias, so testing one requires vitest to
 * resolve it the same way the Next build does.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
