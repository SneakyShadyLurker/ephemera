import { readFileSync, statSync } from "node:fs";

/** Far above one CA certificate or a short chain. */
const MAX_CERTIFICATE_BYTES = 64 * 1024;

/**
 * Reads a PEM CA certificate once at startup, for the ComfyUI transport.
 * Lives here because this module is the only server code allowed to touch the
 * file system (scripts/persistence-audit.ts); it only reads. Undefined when
 * the file is missing, too large or not a PEM certificate.
 */
export function readCertificate(path: string): string | undefined {
  try {
    if (statSync(path).size > MAX_CERTIFICATE_BYTES) return undefined;
    const pem = readFileSync(path, "utf8");
    return pem.includes("-----BEGIN CERTIFICATE-----") ? pem : undefined;
  } catch {
    return undefined;
  }
}
