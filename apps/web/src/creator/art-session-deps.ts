import { effortFor } from "@ephemera/core";
import { queryClient } from "@/app/query.ts";
import { modelsQuery } from "../api.ts";
import { setPortrait } from "../portraits/queries.ts";
import { currentSettings } from "../settings/settings.ts";
import { SignedOut, signIn } from "../signin/signin.ts";
import type { ArtImage, ArtSliceDeps } from "./art-slice.ts";
import { artStatusQuery } from "./queries.ts";
import { streamArt } from "./stream.ts";

/*
 * What every art session reads and sends, whoever hosts it (the creator, a
 * character's sheet): settings, the art status, the model list and the one
 * portrait upload.
 */

/**
 * The model's catalog entry, from the list fetched again if no picker kept it
 * cached; a sign-in refusal waits for the renewal, another failure knows none.
 */
export async function modelInfo(model: string) {
  const models = await queryClient.ensureQueryData(modelsQuery).catch((error: unknown) => {
    if (error instanceof SignedOut) throw error;
    return undefined;
  });
  return models?.find((info) => info.id === model);
}

export const artSessionDeps = {
  streamArt,
  // Asked when art is about to start, so a status changed in Settings meanwhile counts.
  artStatus: (workflow) => queryClient.fetchQuery(artStatusQuery(workflow)),
  workflow: () => currentSettings().comfyuiWorkflow,
  imagePromptModel: () => currentSettings().imagePromptModel,
  // As the reasoning picker narrows it: an effort the model lacks goes as its default; an
  // unlisted model offers every effort.
  artEffort: async (model, reasoning) => effortFor(await modelInfo(model), reasoning),
  signedIn: signIn.signedIn,
  // A candidate kept goes through the server's one portrait pipeline.
  savePortrait: (id: string, png: ArtImage, signal: AbortSignal) =>
    setPortrait("characters", id, new File([png], "portrait.png", { type: "image/png" }), signal),
} satisfies Partial<ArtSliceDeps> & Record<string, unknown>;
