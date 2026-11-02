import { type BrowserContext, test as base, expect } from "@playwright/test";
import { type ComfyScope, comfyScope } from "./creator.ts";
import { patchSettings, readSettings } from "./entities.ts";
import { boundHeaders, freshUser } from "./env.ts";
import type { ScopeOptions } from "./mock-comfyui.ts";
import { answeredBySignIn } from "./signin.ts";

export { expect };

/** The origin of the app server the running test's project uses (playwright.config.ts). */
export function appOrigin(): string {
  const { baseURL } = base.info().project.use;
  if (baseURL === undefined) throw new Error("the project names no app server");
  return baseURL;
}

/**
 * The headers of an unsafe API call as the same-origin app makes it; SWAG's
 * come from the test's user. The boundary takes an unsafe request only as
 * JSON, a body-less one included (an upload sends its multipart type instead).
 */
export const unsafe = () => ({ Origin: appOrigin(), "Content-Type": "application/json" });

/**
 * Collects every Content Security Policy violation in the context, Trusted
 * Types included, through a binding that survives navigations and closed pages.
 */
export async function watchPolicyViolations(context: BrowserContext): Promise<string[]> {
  const violations: string[] = [];
  await context.exposeBinding(
    "__reportPolicyViolation",
    (_source, directive: string, url: string) => {
      // A same-origin request the sign-in redirect sent to the portal (support/signin.ts).
      if (answeredBySignIn(context, directive, url)) return;
      violations.push(`${directive} ${url}`);
    },
  );
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const report = (window as unknown as Record<string, (directive: string, url: string) => void>)
        .__reportPolicyViolation;
      report?.(event.effectiveDirective, event.blockedURI);
    });
  });
  return violations;
}

/**
 * Every test signs in as a user of its own, so its instance, settings
 * included, starts from the seeded baseline and no other test meets it
 * (PRINCIPLES.md 2): `page`, `context`, `request` and every context the test
 * opens carry that user's headers unless it names others. Their settings are
 * read before the test begins, so they hold the seeded presets: settings
 * first read after a test made a preset would choose that one. Every spec fails
 * when the page broke the Content Security Policy (PRINCIPLES.md 2). `comfy`
 * makes a scope of the mock ComfyUI, saves its address for the test's user
 * and removes every scope it made when the test ends.
 */
export const test = base.extend<{
  user: string;
  seeded: undefined;
  policyViolations: string[];
  comfy: (options?: ScopeOptions) => Promise<ComfyScope>;
}>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from its destructuring.
  user: async ({}, use) => {
    await use(freshUser());
  },
  extraHTTPHeaders: async ({ user }, use) => {
    await use(boundHeaders(user));
  },
  seeded: [
    async ({ request }, use) => {
      await readSettings(request);
      await use(undefined);
    },
    { auto: true },
  ],
  policyViolations: [
    async ({ context }, use) => {
      const violations = await watchPolicyViolations(context);
      await use(violations);
      expect(violations, "Content Security Policy violations").toEqual([]);
    },
    { auto: true },
  ],
  comfy: async ({ request }, use) => {
    const scopes: ComfyScope[] = [];
    await use(async (options = {}) => {
      const scope = await comfyScope(options);
      scopes.push(scope);
      await patchSettings(request, { comfyuiBaseUrl: scope.address });
      return scope;
    });
    await Promise.all(scopes.map((scope) => scope.remove()));
  },
});
