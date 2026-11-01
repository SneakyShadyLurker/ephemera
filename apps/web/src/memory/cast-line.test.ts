import { describe, expect, it } from "vitest";
import { castLineDetails, castLineLength, castLinePerson, castLineText } from "./cast-line.ts";

describe("a notebook cast line as a person", () => {
  const line = JSON.stringify({
    name: "Ilse Brandt",
    gender: "female",
    age: "31",
    hair: "black bob",
  });

  it("reads a stored line and writes an unchanged person back as the same line", () => {
    const person = castLinePerson(line);
    expect(person).toEqual({ name: "Ilse Brandt", gender: "female", age: "31", hair: "black bob" });
    expect(castLineDetails(person ?? {})).toEqual(["age", "hair"]);
    expect(castLineText(person ?? {})).toBe(line);
  });

  it("writes an edit in the stored shape: known keys in order, emptied details left out", () => {
    const edited = castLineText({
      hair: "",
      eyes: "grey",
      name: "Noor Haddad",
      gender: "male",
      age: "32",
    });
    expect(edited).toBe(
      JSON.stringify({ name: "Noor Haddad", gender: "male", age: "32", eyes: "grey" }),
    );
  });

  it("reads as a person only a line that seeds a chat; every other line stays text", () => {
    expect(castLinePerson("Ilse, the harbour clerk")).toBeNull();
    expect(castLinePerson('{"name":"Ilse","age":31}')).toBeNull();
    expect(castLinePerson('["Ilse"]')).toBeNull();
    // An unknown key, a missing gender or name, or a gender outside the three: chat seeding refuses them.
    expect(castLinePerson('{"name":"Ilse","gender":"female","note":"kept"}')).toBeNull();
    expect(castLinePerson('{"name":"Ilse"}')).toBeNull();
    expect(castLinePerson('{"name":"","gender":"female"}')).toBeNull();
    expect(castLinePerson('{"name":"Ilse","gender":"woman"}')).toBeNull();
  });

  it("leaves a person with no name yet blank, whatever else is set", () => {
    expect(castLineText({ name: " ", gender: "male" })).toBe("");
    expect(castLineText({ name: "", gender: "other", age: "40" })).toBe("");
  });
});

describe("a cast line's length", () => {
  it("counts a person with no name yet as named, so details alone keep within the limit", () => {
    const details = { gender: "female", age: "40", hair: "w".repeat(200) };
    expect(castLineLength({ name: "", ...details })).toBe(
      castLineText({ name: "x", ...details }).length,
    );
    expect(castLineLength({ name: "Ilse", ...details })).toBe(
      castLineText({ name: "Ilse", ...details }).length,
    );
  });
});
