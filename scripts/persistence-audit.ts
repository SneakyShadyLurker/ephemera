/**
 * Standing check for PRINCIPLES.md 1: every direct dependency has a reviewed
 * persistence entry, application source uses no browser storage, only the
 * server's persistence module touches SQLite or the file system (and it
 * cannot see chat schemas), and the SPA build ships no service worker.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export interface Finding {
  file: string;
  problem: string;
}

interface SourceRule {
  pattern: RegExp;
  problem: string;
}

/** Browser code (the SPA and the shared core it bundles). */
export const BROWSER_RULES: SourceRule[] = [
  { pattern: /\blocalStorage\b/, problem: "uses localStorage" },
  { pattern: /\bsessionStorage\b/, problem: "uses sessionStorage" },
  { pattern: /\bindexedDB\b/, problem: "uses IndexedDB" },
  { pattern: /\bdocument\.cookie\b|\bcookieStore\b/, problem: "uses cookies" },
  { pattern: /\bcaches\s*\.|\bCacheStorage\b/, problem: "uses Cache Storage" },
  { pattern: /\bserviceWorker\b/, problem: "touches service workers" },
  { pattern: /\bnavigator\.storage\b|\bstorageBuckets\b/, problem: "uses the Storage API" },
  {
    pattern: /\b(window|self|globalThis|top|parent)\s*\.\s*name\b/,
    problem: "uses window.name, which survives navigation",
  },
  { pattern: /\bnavigator\s*\[/, problem: "reaches navigator by computed name" },
  { pattern: /\bhistory\.(pushState|replaceState)\b/, problem: "writes history state directly" },
  {
    pattern:
      /\blocation\s*\.\s*(hash|search|href|pathname)\s*\+?=(?!=)|\blocation\s*\.\s*(assign|replace)\s*\(/,
    problem: "writes the URL directly",
  },
  {
    pattern: /\bconst\s+(?!navigate\b)\w+\s*=\s*(Route\.)?useNavigate\s*\(/,
    problem: "names the navigate function otherwise, which hides its search, hash or state",
  },
  {
    pattern:
      /\bnavigate\s*\(\s*\{[\s\S]*?\b(state|search|hash)\s*:|<Link\b(?:[^>]|=>)*\b(state|search|hash)=/,
    problem: "passes router state, search or hash, which reach the URL or history",
  },
  {
    pattern: /\bdocument\.title\s*\+?=(?!=)|<title\b/,
    problem: "sets document.title, which history keeps",
  },
  { pattern: /zustand\/middleware/, problem: "imports Zustand middleware (persist)" },
  {
    pattern: /\bURL\.createObjectURL\b/,
    problem: "creates an object URL, which can turn content into a file",
  },
  {
    pattern: /\bdownload\s*=|["']download["']|\bshowSaveFilePicker\b|\bcreateWritable\b/,
    problem: "creates a downloadable file, which would write content to disk",
  },
  {
    pattern: /scrollRestoration\s*:\s*true/,
    problem: "enables router scroll restoration (sessionStorage)",
  },
  {
    pattern: /persistQueryClient|createSyncStoragePersister|createAsyncStoragePersister/,
    problem: "persists the query cache",
  },
  {
    pattern:
      /(?<![\w$.])(?:(?:window|globalThis|self)\s*\.\s*)?fetch\s*\(|\b(XMLHttpRequest|EventSource|WebSocket|sendBeacon)\b/,
    problem: "requests the network outside the API client's one fetch owner",
  },
  {
    pattern: /\bwindow\s*\.\s*open\b/,
    problem: "opens a window outside the sign-in owner",
  },
];

/** The SPA's HTML entries: the CSP allows same-origin script files only. */
export const HTML_RULES: SourceRule[] = [
  {
    pattern: /<script\b(?![^>]*\bsrc\s*=)[^>]*>/i,
    problem: "has an inline script, which the policy forbids",
  },
  { pattern: /\son[a-z]+\s*=/i, problem: "has an inline event handler" },
];

/** Writes that no server code makes, the persistence module included, apart from its one encrypted writer (EXEMPTIONS). */
const FILE_WRITE_RULES: SourceRule[] = [
  { pattern: /\bBun\.(write|file)\b/, problem: "uses Bun file I/O" },
  {
    pattern: /\b(writeFile|appendFile|createWriteStream|mkdtemp|copyFile|rename)\w*\s*\(/,
    problem: "writes files",
  },
  { pattern: /\btmpdir\s*\(/, problem: "uses the temp directory" },
  { pattern: /\.toFile\s*\(/, problem: "writes an image file (sharp toFile)" },
];

/** The one module allowed to write (apps/server/src/persistence). */
export const PERSISTENCE_DIR = "apps/server/src/persistence/";

/** Server code outside the persistence module: no file system, no database. */
export const SERVER_RULES: SourceRule[] = [
  {
    pattern: /(from\s+|import\s*\(\s*|require\s*\(\s*)["'](node:)?fs(\/promises)?["']/,
    problem: "imports the file system",
  },
  ...FILE_WRITE_RULES,
  { pattern: /bun:sqlite/, problem: "opens a database outside the persistence layer" },
  {
    pattern: /(from\s+|import\s*\(\s*)["']drizzle-orm/,
    problem: "queries the database outside the persistence layer",
  },
];

/**
 * The persistence module: it may open SQLite and create the data directory,
 * but has no path to chat content: no chat schema or type is in reach.
 */
export const PERSISTENCE_RULES: SourceRule[] = [
  ...FILE_WRITE_RULES,
  {
    pattern:
      /\b(chatTurnSchema|chatRoleSchema|generateRequestSchema|ChatTurn|ChatRole|GenerateRequest|ChatMessage)\b|["'][^"']*\/chat(\.ts)?["']/,
    problem: "reaches a chat schema, type or module from the persistence layer",
  },
];

/**
 * Reviewed exceptions, each for one file and one rule. Card, lorebook and
 * preset exports download that item, never chat content: a same-origin link
 * to the export route with the `download` attribute, so the page does not
 * navigate. The lorebook routes keep only an entry's index in its book in
 * their URL, and an inspector link names one the same way. The API
 * client owns the network and the sign-in owner the renewal window. The
 * persistence module writes its users' databases and portrait files through
 * one encrypted writer.
 */
export const EXEMPTIONS: { file: string; problem: string; reason: string }[] = [
  {
    file: "apps/web/src/signin/ExportLink.tsx",
    problem: "creates a downloadable file, which would write content to disk",
    reason:
      "Downloads a character card, a library lorebook or one preset from the export route its typed target names; no chat content is in reach.",
  },
  {
    file: "apps/web/src/signin/download.ts",
    problem: "creates a downloadable file, which would write content to disk",
    reason:
      "Downloads the export an export link names (a card, a preset or a lorebook), after confirming the session; no chat content is in reach.",
  },
  {
    file: "apps/web/src/api.ts",
    problem: "requests the network outside the API client's one fetch owner",
    reason:
      "The one fetch owner: every API request, the chat stream included, with manual redirects so an expired sign-in is recognized.",
  },
  {
    file: "apps/web/src/signin/signin.ts",
    problem: "opens a window outside the sign-in owner",
    reason:
      "Opens the same-origin renewal page with noopener; the URL is a constant and carries nothing of the chat.",
  },
  {
    file: "apps/web/src/lorebook/entry-search.ts",
    problem: "passes router state, search or hash, which reach the URL or history",
    reason:
      "The open entry's index in a character's card or a library lorebook (book data, validated as a number), so Back closes it on phones; no chat content is in reach.",
  },
  {
    file: "apps/web/src/lorebook/EntryLink.tsx",
    problem: "passes router state, search or hash, which reach the URL or history",
    reason:
      "Links to one lorebook entry's editor by its index in its book (book data, a number); followed only by the owner's click, it names no chat content.",
  },
  {
    file: "apps/web/src/chat/MemoryMark.tsx",
    problem: "passes router state, search or hash, which reach the URL or history",
    reason:
      "Opens the memory screen with the constant `from=chat` (a static UI origin, validated as that one literal), so its Back returns to the chat; no chat content is in reach.",
  },
  {
    file: "apps/web/src/memory/FailureAction.tsx",
    problem: "passes router state, search or hash, which reach the URL or history",
    reason:
      "A full memory book's way out opens the memory screen with the constant `from=chat`, as the chat's Memory mark does; no chat content is in reach.",
  },
  {
    file: "apps/web/src/settings/window-link.tsx",
    problem: "passes router state, search or hash, which reach the URL or history",
    reason:
      "Links to Settings with a model ID (a setting, validated as one) so Context focuses that model's window field, then clears it; no chat content is in reach.",
  },
  {
    file: "apps/server/src/persistence/encrypted-file.ts",
    problem: "writes files",
    reason:
      "The one encrypted-file writer: ciphertext only, a temp file renamed over the user's database file or one of the user's portrait files in the user's own folder.",
  },
];

export const isExempt = (file: string, problem: string) =>
  EXEMPTIONS.some((exemption) => exemption.file === file && exemption.problem === problem);

/**
 * The exemptions no finding needed: their file is gone, or no longer does
 * what they excuse. `exempted` holds the findings exemptions waived.
 */
export function staleExemptions(exempted: Finding[]): Finding[] {
  return EXEMPTIONS.filter(
    (exemption) =>
      !exempted.some(
        (finding) => finding.file === exemption.file && finding.problem === exemption.problem,
      ),
  ).map((exemption) => ({
    file: "scripts/persistence-audit.ts",
    problem: `stale exemption: ${exemption.file} ${exemption.problem}`,
  }));
}

export function auditSource(file: string, text: string, rules: SourceRule[]): Finding[] {
  return rules
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => ({ file, problem: rule.problem }));
}

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function auditDependencies(
  manifests: Record<string, Manifest>,
  reviewed: Record<string, unknown>,
): Finding[] {
  const findings: Finding[] = [];
  const used = new Set<string>();
  for (const [file, manifest] of Object.entries(manifests)) {
    for (const [name, version] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      if (version.startsWith("workspace:")) continue;
      used.add(name);
      if (!(name in reviewed))
        findings.push({ file, problem: `dependency ${name} has no persistence review` });
    }
  }
  for (const name of Object.keys(reviewed)) {
    if (!used.has(name))
      findings.push({ file: "scripts/persistence-audit.json", problem: `stale entry ${name}` });
  }
  return findings;
}

/** A built SPA must not contain a service worker or a web app manifest. */
export function auditBuild(files: { path: string; text: string }[]): Finding[] {
  const findings: Finding[] = [];
  for (const { path, text } of files) {
    if (/(^|\/)(sw|service-worker|workbox-[\w-]+)\.js$|\.webmanifest$/.test(path)) {
      findings.push({ file: path, problem: "service worker or manifest in the build" });
    }
    if (/serviceWorker\s*\.\s*register/.test(text)) {
      findings.push({ file: path, problem: "registers a service worker" });
    }
  }
  return findings;
}

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function main(root: string): Promise<number> {
  const findings: Finding[] = [];
  const rel = (path: string) => relative(root, path);

  // The root manifest and every workspace's, as the root's `workspaces` globs name them.
  const manifestPaths = ["package.json"];
  const { workspaces = [] } = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    workspaces?: string[];
  };
  for (const pattern of workspaces) {
    for await (const path of new Bun.Glob(`${pattern}/package.json`).scan({ cwd: root })) {
      manifestPaths.push(path);
    }
  }
  const manifests: Record<string, Manifest> = {};
  for (const path of manifestPaths.toSorted())
    manifests[path] = JSON.parse(await readFile(join(root, path), "utf8"));
  const reviewed = JSON.parse(
    await readFile(join(root, "scripts/persistence-audit.json"), "utf8"),
  ) as {
    dependencies: Record<string, unknown>;
  };
  findings.push(...auditDependencies(manifests, reviewed.dependencies));

  const scans: [string, (file: string) => SourceRule[]][] = [
    ["apps/web/src", () => BROWSER_RULES],
    ["packages/core/src", () => BROWSER_RULES],
    [
      "apps/server/src",
      (file) => (file.startsWith(PERSISTENCE_DIR) ? PERSISTENCE_RULES : SERVER_RULES),
    ],
  ];
  const exempted: Finding[] = [];
  for (const [dir, rulesFor] of scans) {
    for (const file of await listFiles(join(root, dir))) {
      if (!SOURCE_FILE.test(file) || TEST_FILE.test(file)) continue;
      const path = rel(file);
      for (const finding of auditSource(path, await readFile(file, "utf8"), rulesFor(path))) {
        (isExempt(finding.file, finding.problem) ? exempted : findings).push(finding);
      }
    }
  }
  findings.push(...staleExemptions(exempted));

  for (const entry of ["apps/web/index.html", "apps/web/auth/renewed.html"]) {
    findings.push(...auditSource(entry, await readFile(join(root, entry), "utf8"), HTML_RULES));
  }

  const dist = join(root, "apps/web/dist");
  if (await exists(dist)) {
    const files = await Promise.all(
      (await listFiles(dist)).map(async (path) => ({
        path: rel(path),
        text: await readFile(path, "utf8"),
      })),
    );
    findings.push(...auditBuild(files));
  } else {
    console.log("Build output not found; run `bun run build` to include the build scan.");
  }

  for (const finding of findings) console.error(`${finding.file}: ${finding.problem}`);
  console.log(
    findings.length === 0
      ? "Persistence audit passed."
      : `Persistence audit failed: ${findings.length} finding(s).`,
  );
  return findings.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(join(import.meta.dirname, ".."));
}
