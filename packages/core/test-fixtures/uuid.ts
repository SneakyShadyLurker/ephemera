let counter = 0;

/** Distinct version-4 UUIDs without a runtime crypto global (core has no I/O types). */
export const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
