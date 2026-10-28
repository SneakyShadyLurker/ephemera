/** Where an arrow key, Home or End moves in a row of `count` options; undefined for other keys. */
export function stepOption(key: string, at: number, count: number): number | undefined {
  if (count === 0) return undefined;
  switch (key) {
    case "ArrowLeft":
    case "ArrowUp":
      return (at - 1 + count) % count;
    case "ArrowRight":
    case "ArrowDown":
      return (at + 1) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}
