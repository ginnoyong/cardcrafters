import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Test-run config: ONLY adds the apps/web "@" path alias (Next's tsconfig
 * paths are not read by vitest). Test discovery and all other defaults are
 * unchanged — every pre-existing test relies on vitest's defaults.
 */
export default defineConfig({
  // Next source uses the automatic JSX runtime (no `import React`);
  // vitest's esbuild transform must match.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
});
