/*
 * Kept free of imports: chat.ts's request contract and sampler.ts's preset
 * both read it, and sampler.ts already imports chat.ts.
 */

/**
 * Every effort a preset can choose: the AI SDK's `reasoning` levels, which the
 * server checks against the SDK's own type (upstream.ts); "provider-default"
 * sends nothing. CLIProxyAPI's catalog also lists `ultra`, which its chat
 * endpoint refuses, so it is not one.
 */
export const REASONING_EFFORTS = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
