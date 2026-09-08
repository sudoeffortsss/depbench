import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `_backup/` holds verbatim copies of source files taken before a rebuild, including
    // test files. Vitest's default glob picked one up and ran it against the *backed-up*
    // module next to it, silently adding a passing suite for code that is no longer in
    // the project: the run reported 58 tests where the project has 42. Excluded rather
    // than deleted, because the backups are the rollback path on a machine with none.
    exclude: ["**/node_modules/**", "**/dist/**", "_backup/**"],
  },
});
