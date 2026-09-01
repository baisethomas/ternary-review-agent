import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * Mirrors the `@/*` -> `./src/*` alias from tsconfig.json.
 *
 * Every module under `src/lib` is tested through a relative import and never
 * needed this. Modules under `src/app` — Server Actions in particular — import
 * their dependencies through the alias, so testing one requires vitest to
 * resolve it the same way the Next build does. The alias resolves relative to
 * THIS file's location, so the same config works in the main checkout and in
 * any agent worktree copy.
 *
 * `.claude/worktrees/**` is excluded from the sweep: agent worktrees carry
 * diverged copies of the source, and a root-level test run resolving their
 * files against the root's modules produces cross-worktree false failures
 * (observed repeatedly by the stop hook's `npm test`). Each worktree runs its
 * own suite from its own root; the parent's sweep must not re-run them.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    exclude: [...configDefaults.exclude, ".claude/worktrees/**"],
  },
});
