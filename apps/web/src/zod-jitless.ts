/**
 * Every `zod` import in the web bundle resolves here (vite.config.ts alias),
 * so jitless mode is set before any module can create a schema. Zod decides
 * whether to generate code with `new Function` when a schema is created, and
 * the CSP and Trusted Types forbid it (zod.dev/compile). Setting it in
 * main.tsx is too late: bundled chunks that define schemas at module level
 * (packages/core's card schemas) are evaluated before the entry's own code.
 */
import { config } from "zod/v4";

config({ jitless: true });

export * from "zod/v4";
export { default } from "zod/v4";
