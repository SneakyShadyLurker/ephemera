import { describe, expect, it } from "vitest";
import {
  auditBuild,
  auditDependencies,
  auditSource,
  BROWSER_RULES,
  EXEMPTIONS,
  HTML_RULES,
  isExempt,
  PERSISTENCE_RULES,
  SERVER_RULES,
  staleExemptions,
} from "./persistence-audit.ts";

describe("persistence audit", () => {
  it("flags an unreviewed dependency and a stale review", () => {
    const findings = auditDependencies(
      {
        "apps/web/package.json": {
          dependencies: { react: "^19", "new-lib": "^1", "@ephemera/core": "workspace:*" },
        },
      },
      { react: {}, "old-lib": {} },
    );
    expect(findings.map((f) => f.problem)).toEqual([
      "dependency new-lib has no persistence review",
      "stale entry old-lib",
    ]);
  });

  it.each([
    "localStorage.setItem('draft', text)",
    "window.sessionStorage.getItem('x')",
    "indexedDB.open('chat')",
    "document.cookie = 'a=b'",
    "await caches.open('v1')",
    "navigator.serviceWorker.register('/sw.js')",
    "window.name = JSON.stringify(messages)",
    "history.replaceState({ messages }, '')",
    "import { persist } from 'zustand/middleware'",
    "createRouter({ routeTree, scrollRestoration: true })",
    "navigate({ to: '/', search: { draft } })",
    "<Link to='/' state={{ messages }}>",
    "document.title = message.text",
    "await fetch('/api/chat', { method: 'POST' })",
    "const source = new EventSource('/api/stream')",
    "navigator.sendBeacon('/api/log', body)",
    "window.open('/auth/renewed')",
    "const o = window.open; o(url)",
    "await window.fetch('/x')",
    "globalThis.fetch(url)",
    "const request = new XMLHttpRequest()",
    "const socket = new window.WebSocket(url)",
    "location.hash = draft",
    "window.location.assign('?q=' + draft)",
    "const go = useNavigate(); go({ search: { q: draft } })",
    "<Link onClick={() => x()} search={{ q: draft }}>",
    "<title>{text}</title>",
    "document.title += draft",
    "a.setAttribute('download', name)",
    "const handle = await showSaveFilePicker()",
    "self.name = draft",
    "navigator['storage'].persist()",
  ])("flags browser persistence: %s", (code) => {
    expect(auditSource("x.ts", code, BROWSER_RULES)).toHaveLength(1);
  });

  it.each([
    "import { writeFile } from 'node:fs/promises'",
    "await Bun.write('/tmp/chat.json', body)",
    "import { Database } from 'bun:sqlite'",
    "const dir = tmpdir()",
    "await Bun.file('/tmp/chat.json').writer()",
    "const fs = await import('node:fs')",
    "const fs = require('fs')",
  ])("flags server writes: %s", (code) => {
    expect(auditSource("x.ts", code, SERVER_RULES).length).toBeGreaterThan(0);
  });

  it.each([
    "import { drizzle } from 'drizzle-orm/bun-sqlite'",
    'import { eq } from "drizzle-orm"',
    "await Bun.write(path, bytes)",
    "import { mkdirSync } from 'node:fs'",
    "await sharp(bytes).png().toFile('/data/portrait.png')",
  ])("keeps the database and file system out of server code: %s", (code) => {
    expect(auditSource("apps/server/src/api.ts", code, SERVER_RULES).length).toBeGreaterThan(0);
  });

  it("lets the persistence module open SQLite and create its directory", () => {
    const code = [
      "import { Database } from 'bun:sqlite';",
      "import { mkdirSync } from 'node:fs';",
      "import { drizzle } from 'drizzle-orm/bun-sqlite';",
      "import { characterCardSchema } from '@ephemera/core';",
    ].join("\n");
    expect(auditSource("apps/server/src/persistence/db.ts", code, PERSISTENCE_RULES)).toEqual([]);
  });

  it.each([
    "import { generateRequestSchema } from '@ephemera/core'",
    "import type { ChatTurn } from '@ephemera/core'",
    "import { chatTurnSchema } from '../../../packages/core/src/chat.ts'",
    "import { thing } from './chat'",
    "export function saveMessages(messages: ChatMessage[]) {}",
    "await Bun.write(file, JSON.stringify(card))",
    "await writeFile(path, text)",
  ])("keeps chat out of the persistence module: %s", (code) => {
    expect(
      auditSource("apps/server/src/persistence/x.ts", code, PERSISTENCE_RULES).length,
    ).toBeGreaterThan(0);
  });

  it("exempts only the reviewed file from the download rule, and never object URLs", () => {
    const [exemption] = EXEMPTIONS;
    expect(exemption?.file).toBe("apps/web/src/signin/ExportLink.tsx");
    expect(isExempt("apps/web/src/signin/ExportLink.tsx", exemption?.problem ?? "")).toBe(true);
    expect(isExempt("apps/web/src/chat/Thread.tsx", exemption?.problem ?? "")).toBe(false);
    const objectUrl = BROWSER_RULES.find((rule) => rule.pattern.test("URL.createObjectURL(blob)"));
    expect(isExempt("apps/web/src/signin/ExportLink.tsx", objectUrl?.problem ?? "")).toBe(false);
  });

  it("lets only the encrypted writer write files in the persistence module", () => {
    const writer = "apps/server/src/persistence/encrypted-file.ts";
    const code = "await handle.writeFile(bytes);\nawait rename(temp, path);";
    const rules = (file: string) =>
      PERSISTENCE_RULES.filter((rule) => !isExempt(file, rule.problem));
    expect(auditSource(writer, code, rules(writer))).toEqual([]);
    expect(auditSource(writer, "await Bun.write(path, bytes)", rules(writer)).length).toBe(1);
    for (const other of [
      "apps/server/src/persistence/db.ts",
      "apps/server/src/persistence/instances.ts",
      "apps/server/src/persistence/portrait-files.ts",
    ]) {
      expect(auditSource(other, code, rules(other))).toEqual([
        { file: other, problem: "writes files" },
      ]);
    }
  });

  it("flags an exemption no finding needed, and none that waived one", () => {
    const [kept, ...stale] = EXEMPTIONS;
    if (kept === undefined) throw new Error("no exemption");
    const findings = staleExemptions([{ file: kept.file, problem: kept.problem }]);
    expect(findings.map((finding) => finding.problem)).toEqual(
      stale.map((exemption) => `stale exemption: ${exemption.file} ${exemption.problem}`),
    );
  });

  it("passes clean code", () => {
    expect(auditSource("x.ts", "const store = createStore(() => ({}))", BROWSER_RULES)).toEqual([]);
    expect(auditSource("x.ts", "return c.json({ ok: true })", SERVER_RULES)).toEqual([]);
    expect(auditSource("x.ts", "if (document.title === 'x') {}", BROWSER_RULES)).toEqual([]);
  });

  it("flags a service worker in the build", () => {
    expect(auditBuild([{ path: "dist/sw.js", text: "" }])).toHaveLength(1);
    expect(
      auditBuild([
        { path: "dist/assets/index.js", text: "navigator.serviceWorker.register('/x')" },
      ]),
    ).toHaveLength(1);
    expect(auditBuild([{ path: "dist/assets/index.js", text: "console.log(1)" }])).toEqual([]);
  });

  it.each([
    "<script>window.x = 1</script>",
    '<script type="module">import "./a.js"</script>',
    '<button onclick="go()">Go</button>',
  ])("flags inline code in an HTML entry: %s", (html) => {
    expect(auditSource("x.html", html, HTML_RULES)).toHaveLength(1);
  });

  it("passes an HTML entry that loads its script from a file", () => {
    const html = '<main class="grid"></main><script type="module" src="/src/main.tsx"></script>';
    expect(auditSource("x.html", html, HTML_RULES)).toEqual([]);
  });
});
