import { expect, it } from "vitest";
import { isVersionFolder } from "./release.ts";

it("counts only the folders the installer and updates make as versions to remove", () => {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  for (const name of [`app-${commit}`, `app-${commit}.partial`, `app-${commit}.partial.tar.gz`]) {
    expect(isVersionFolder(name)).toBe(true);
  }
  for (const name of ["app-library", "app-data", `app-${commit}-old`, "data", ".env", "current"]) {
    expect(isVersionFolder(name)).toBe(false);
  }
});
