import {
  type ComfyuiWorkflowOption,
  type CreatorArtStatus,
  DEFAULT_SETTINGS,
  type Settings,
  userWorkflowId,
  WORKFLOW_LIMITS,
  type WorkflowSummary,
} from "@ephemera/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ART_STATUS_KEY, artWorkflowsQuery } from "../creator/queries.ts";
import { settingsQuery } from "../settings/settings.ts";
import { workflowsQuery } from "./queries.ts";
import { Workflows } from "./Workflows.tsx";

vi.mock("@/app/form-factor.ts", async (original) => ({
  ...(await original<typeof import("@/app/form-factor.ts")>()),
  useFormFactor: () => "desktop",
}));

const FLUX = "0b6f7c3e-2d4a-4f8e-9a1b-5c6d7e8f9a0b";
const MOSS = "1c7f8d4e-3e5b-4f9e-8a2b-6d7e8f9a0b1c";
const SERVER = "krea2-gonzalomo";
// The catalog, the settings and the status queries name a user workflow by its `user-` id.
const FLUX_ID = userWorkflowId(FLUX);
const MOSS_ID = userWorkflowId(MOSS);

const summary = (id: string, name: string, family: WorkflowSummary["family"], nodes: number) => ({
  id,
  name,
  family,
  nodes,
  revision: 0,
  updatedAt: 0,
});
const YOURS: WorkflowSummary[] = [
  summary(FLUX, "Flux Dev Portrait", "general", 38),
  summary(MOSS, "Moss Studio", "moss", 22),
];
const OPTIONS: ComfyuiWorkflowOption[] = [
  { id: SERVER, name: "Krea 2 Gonzalomo", family: "krea2", scope: "server" },
  { id: FLUX_ID, name: "Flux Dev Portrait", family: "general", scope: "user" },
  { id: MOSS_ID, name: "Moss Studio", family: "moss", scope: "user" },
];
const STATUSES: Record<string, CreatorArtStatus> = {
  [FLUX_ID]: { state: "ready" },
  [MOSS_ID]: {
    state: "missing",
    nodes: ["TextEncodeMOSSImageEdit"],
    models: ["moss_v2.safetensors"],
  },
  [SERVER]: { state: "ready" },
};

/** Renders the list with its queries answered (`yours` "failed" keeps no rows, "stale" keeps them). */
function render({
  yours = YOURS,
  failed = false,
  statuses = STATUSES,
  settings = {},
}: {
  yours?: WorkflowSummary[];
  failed?: boolean;
  statuses?: Record<string, CreatorArtStatus>;
  settings?: Partial<Settings>;
} = {}) {
  const client = new QueryClient();
  client.setQueryData(settingsQuery.queryKey, {
    ...DEFAULT_SETTINGS,
    comfyuiBaseUrl: "http://comfyui.local:8188",
    comfyuiWorkflow: FLUX_ID,
    ...settings,
  });
  client.setQueryData(workflowsQuery.queryKey, yours);
  if (failed) {
    client
      .getQueryCache()
      .find({ queryKey: workflowsQuery.queryKey })
      ?.setState({ status: "error", error: new Error("unavailable"), fetchStatus: "idle" });
  }
  client.setQueryData(artWorkflowsQuery.queryKey, OPTIONS);
  for (const [id, status] of Object.entries(statuses)) {
    client.setQueryData([...ART_STATUS_KEY, id], status);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Workflows importRef={createRef()} onImport={() => {}} onReplace={() => {}} />
    </QueryClientProvider>,
  );
}

/** Each row's markup, by the workflow's name. */
const rows = (markup: string) => markup.split("<li").slice(1);
const rowOf = (markup: string, name: string) => rows(markup).find((row) => row.includes(name));

describe("the workflows list in Settings > Pictures", () => {
  it("groups the user's workflows before the server's, family and nodes as text", () => {
    const markup = render();
    expect(markup).toContain("Import a workflow");
    expect(markup.indexOf("Yours")).toBeLessThan(markup.indexOf("Flux Dev Portrait"));
    expect(markup.indexOf("Moss Studio")).toBeLessThan(markup.indexOf("On this server"));
    expect(markup.indexOf("On this server")).toBeLessThan(markup.indexOf("Krea 2 Gonzalomo"));
    expect(rowOf(markup, "Flux Dev Portrait")).toContain("General");
    expect(rowOf(markup, "Flux Dev Portrait")).toContain("38 nodes");
    expect(rowOf(markup, "Moss Studio")).toContain("MOSS");
    // Server rows carry no node count.
    expect(rowOf(markup, "Krea 2 Gonzalomo")).not.toContain("nodes");
  });

  it("puts words beside every dot and marks the workflow in use", () => {
    const markup = render();
    for (const row of rows(markup)) {
      expect(row).toMatch(/Ready|Checking|Missing requirements|Unavailable|Unchecked/);
    }
    expect(rowOf(markup, "Flux Dev Portrait")).toContain("In use");
    expect(rowOf(markup, "Krea 2 Gonzalomo")).not.toContain("In use");
    const moss = rowOf(markup, "Moss Studio");
    expect(moss).toContain("Missing requirements");
    expect(moss).toContain("TextEncodeMOSSImageEdit");
    expect(moss).toContain("moss_v2.safetensors");
    expect(rowOf(markup, "Flux Dev Portrait")).not.toContain("Model files");
  });

  it("reads Unchecked without an address and Checking while asking", () => {
    const off = render({
      settings: { comfyuiBaseUrl: "" },
      statuses: {
        [FLUX_ID]: { state: "off" },
        [MOSS_ID]: { state: "off" },
        [SERVER]: { state: "off" },
      },
    });
    for (const row of rows(off)) expect(row).toContain("Unchecked");
    const asking = render({ statuses: {} });
    for (const row of rows(asking)) expect(row).toContain("Checking");
  });

  it("names each user row's actions button, and server rows have none", () => {
    const markup = render();
    expect(rowOf(markup, "Flux Dev Portrait")).toContain(
      'aria-label="Actions for Flux Dev Portrait"',
    );
    expect(rowOf(markup, "Moss Studio")).toContain('aria-label="Actions for Moss Studio"');
    expect(rowOf(markup, "Krea 2 Gonzalomo")).not.toContain("Actions for");
  });

  it("keeps Import focusable at the limit and says why it does nothing", () => {
    const open = render();
    expect(open).not.toContain('aria-disabled="true"');
    const full = render({
      yours: Array.from({ length: WORKFLOW_LIMITS.workflows }, (_, index) =>
        summary(
          `${String(index).padStart(8, "0")}-2d4a-4f8e-9a1b-5c6d7e8f9a0b`,
          `W${index}`,
          "general",
          3,
        ),
      ),
    });
    const button = full.match(/<button[^>]*>(?:(?!<\/button>).)*Import a workflow/)?.[0] ?? "";
    expect(button).toContain('aria-disabled="true"');
    expect(button).not.toMatch(/\sdisabled=""/);
    const described = button.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(described).toBeDefined();
    expect(full).toMatch(
      new RegExp(
        `id="${described}"[^>]*>24 workflows is the most Ephemera keeps\\. Delete one to import another\\.`,
      ),
    );
  });

  it("invites an import when the user has none", () => {
    const markup = render({ yours: [] });
    expect(markup).toContain(
      "Nothing of yours yet. Import a workflow from ComfyUI and it appears here, ready to paint.",
    );
    expect(markup).toContain("Krea 2 Gonzalomo");
  });

  it("keeps the last rows when the list could not be refreshed", () => {
    const markup = render({ failed: true });
    expect(markup).toContain("Flux Dev Portrait");
    expect(markup).toContain("The list could not be refreshed: Ephemera could not be reached.");
    expect(markup).toContain("Try again");
  });
});
