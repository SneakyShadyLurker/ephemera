import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** The source trees whose imports decide which areas a change reaches. */
const TREES = ["apps/web/src", "apps/server/src", "packages/core/src"];
const CORE = "packages/core/src/index.ts";
const SOURCE = /\.tsx?$/;
/** What the bundler tries after an import path that names no file: an extension, then an index. */
const SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const TEST = /\.test\.tsx?$/;

/** Who imports each source file, by repository path. */
export type Importers = Map<string, Set<string>>;

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};
const scan = (file: string, code: string) =>
  transpilers[file.endsWith(".tsx") ? "tsx" : "ts"].scan(code);

/** The value names of a `{ a, type B, c as d }` list, as the module they come from calls them. */
function names(list: string): string[] {
  return list
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "" && !name.startsWith("type "))
    .map((name) => name.split(/\s+as\s+/)[0] ?? name);
}

/**
 * The import graph of the app's source, reversed. Type-only imports are
 * erased, as at run time. An import from `@ephemera/core` points at the
 * module that defines each name, followed through the package's index
 * files, so a core module is tied to the code that uses it rather than to
 * everything that imports the package. A name no module defines throws:
 * the caller then has no graph and takes the whole suite.
 */
export function importersOf(root: string): Importers {
  const files = TREES.flatMap((tree) =>
    (readdirSync(join(root, tree), { recursive: true }) as string[])
      .map((file) => join(tree, file))
      .filter((file) => SOURCE.test(file) && !TEST.test(file)),
  );
  const text = new Map(files.map((file) => [file, readFileSync(join(root, file), "utf8")]));
  const own = new Map([...text].map(([file, code]) => [file, new Set(scan(file, code).exports)]));

  /** The file that defines `name` as `module` exports it, through re-exports. */
  function origin(module: string, name: string, seen = new Set<string>()): string | undefined {
    if (seen.has(module)) return undefined;
    seen.add(module);
    const code = text.get(module);
    if (code === undefined) return undefined;
    const from = (path: string) => relative(root, resolve(root, dirname(module), path));
    for (const [, list, path] of code.matchAll(/export\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
      const renamed = (list ?? "")
        .split(",")
        .map((entry) =>
          entry
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/),
        )
        .find(([source, alias]) => (alias ?? source) === name);
      if (renamed?.[0] !== undefined && path !== undefined) {
        return origin(from(path), renamed[0], seen) ?? from(path);
      }
    }
    for (const [, path] of code.matchAll(/export\s*\*\s*from\s*"([^"]+)"/g)) {
      const found = path === undefined ? undefined : origin(from(path), name, seen);
      if (found !== undefined) return found;
    }
    return own.get(module)?.has(name) ? module : undefined;
  }

  const importers: Importers = new Map();
  const tie = (target: string, importer: string) => {
    const known = importers.get(target) ?? new Set<string>();
    known.add(importer);
    importers.set(target, known);
  };
  for (const [file, code] of text) {
    for (const { path } of scan(file, code).imports) {
      if (path === "@ephemera/core") continue;
      const target = path.startsWith("@/")
        ? join("apps/web/src", path.slice(2))
        : path.startsWith(".")
          ? relative(root, resolve(root, dirname(file), path))
          : undefined;
      if (target === undefined) continue;
      const source = SUFFIXES.map((suffix) => target + suffix).find((candidate) =>
        text.has(candidate),
      );
      if (source !== undefined) tie(source, file);
      else if (existsSync(join(root, target))) tie(target, file);
    }
    for (const [statement, list] of code.matchAll(
      /import\s+(?!type\b)([^;]*?)\s+from\s*"@ephemera\/core"/gs,
    )) {
      const braces = /^\{([^}]*)\}$/s.exec((list ?? "").trim());
      if (braces === null) throw new Error(`unreadable core import in ${file}: ${statement}`);
      for (const name of names(braces[1] ?? "")) {
        const defined = origin(CORE, name);
        if (defined === undefined) throw new Error(`${file} imports ${name}, which core lacks`);
        tie(defined, file);
      }
    }
  }
  return importers;
}

/**
 * The files that import `file`, directly or transitively. Stop before the
 * `hub`s: their imports say nothing about where a change lands. Cycles
 * never return the changed file itself.
 */
export function usersOf(
  importers: Importers,
  file: string,
  hub: (path: string) => boolean,
): string[] {
  const seen = new Set([file]);
  const users = new Set<string>();
  const pending = [file];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    for (const importer of importers.get(next) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      if (hub(importer)) continue;
      users.add(importer);
      pending.push(importer);
    }
  }
  return [...users].sort();
}
