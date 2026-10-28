/** Safe filename shared by HTTP downloads and the browser. */
export function exportFileName(name: string, extension: "png" | "json"): string {
  const cleaned = Array.from(
    name
      .toWellFormed()
      .replace(/[\p{Cc}\p{Cf}\\/:*?"<>|]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, 100)
    .join("")
    .trim();
  return `${cleaned === "" ? "character" : cleaned}.${extension}`;
}
