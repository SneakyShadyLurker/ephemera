/** A type guard for one of a tuple's values, for the `unknown` values Base UI's controls hand back. */
export const oneOf =
  <const T extends readonly unknown[]>(values: T) =>
  (value: unknown): value is T[number] =>
    values.includes(value);
