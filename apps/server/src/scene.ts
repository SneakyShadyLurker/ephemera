import {
  type ArtStreamEvent,
  SCENE_METAPROMPTS,
  savedCardKind,
  scenePrompt,
  sceneRequestSchema,
} from "@ephemera/core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import {
  ART_TIMEOUT_MS,
  admittedWorkflow,
  artEventStream,
  type CreatorDeps,
  MAX_CREATOR_BODY_BYTES,
  paint,
} from "./creator.ts";
import { boundedBody, requestLifetime } from "./lifetime.ts";
import { invalid, invalidRequest } from "./routes.ts";
import { callRecorder } from "./usage.ts";
import type { UserEnv } from "./user.ts";

/*
 * Picture this scene (PRINCIPLES.md 1): the scene source the tab built from
 * the card and the chat's latest turns, the image prompt written from it and
 * the one picture painted are chat content. They live in this request's
 * memory only, stream to the browser in the framed art stream and are
 * never written, cached or logged. A Subject or Group card's stored portrait
 * goes to a model that reads images, and its top third to the workflow's
 * reference graph, which runs only on Atelier's private worker; a Scenario
 * card sends no portrait anywhere.
 */

const SCENE_ERROR = "scene.error";

export type SceneDeps = Pick<
  CreatorDeps,
  "log" | "catalog" | "upstream" | "comfyui" | "catalogFor" | "onStreamingRequest" | "stopping"
>;

export function createSceneApi(deps: SceneDeps) {
  const { log } = deps;
  return new Hono<UserEnv>().post(
    "/",
    requestLifetime(ART_TIMEOUT_MS, deps.onStreamingRequest),
    boundedBody(MAX_CREATOR_BODY_BYTES),
    zValidator("json", sceneRequestSchema, invalid),
    (c) => {
      const { model, reasoning, source, characterId, ...body } = c.req.valid("json");
      // The run reads the requester's own stores after the handler returned.
      const { characters } = c.var.user.stores;
      const saved = c.var.user.stores.settings.get();
      const workflow = admittedWorkflow(deps.catalogFor(c), body.workflow, saved.comfyuiWorkflow);
      if (workflow === undefined) return invalidRequest(c);
      return artEventStream(c, deps.stopping, { log, event: SCENE_ERROR }, (sendEvent, signal) => {
        const recorder = callRecorder();
        let reported = false;
        // The prompt call's receipt rides on its end, or on the error that ends the run first.
        const send = (event: ArtStreamEvent) => {
          if (
            !reported &&
            (event.type === "error" ||
              (event.type === "progress" && event.phase === "prompt" && event.value === event.max))
          ) {
            reported = true;
            sendEvent({ ...event, accounting: recorder.snapshot() });
          } else sendEvent(event);
        };
        return paint(deps, {
          event: "scene",
          model,
          reasoning,
          settings: saved,
          workflow,
          count: 1,
          /*
           * The character comes from the requester's own instance, so another
           * user's id finds nothing. Its kind is the stored card's, whatever
           * the tab sent.
           */
          source: () => {
            const character = characters.get(characterId);
            if (character === undefined) return "not_found";
            const kind = savedCardKind(character.card.tags);
            return {
              ...(kind === "scenario"
                ? {}
                : {
                    portrait: async () => (await characters.portrait(characterId, "full"))?.bytes,
                    referenceGraph: true,
                  }),
              instructions: SCENE_METAPROMPTS[workflow.family][kind],
              text: (portrait) => scenePrompt(source, portrait),
            };
          },
          recording: { recorder, purpose: "scene.prompt" },
          send,
          signal,
        });
      });
    },
  );
}
