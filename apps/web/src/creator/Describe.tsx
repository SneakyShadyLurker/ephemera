import { CREATOR_LIMITS, type CreatorKind } from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef } from "react";
import { ModelSelect } from "@/components/model-select";
import { Button, buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { isComposing } from "@/lib/keys.ts";
import { modelsQuery, useModelOptions } from "../api.ts";
import { useChatPersona } from "../chat/character.ts";
import { PersonaSelect } from "../personas/PersonaSelect.tsx";
import { StatusDot } from "../settings/Portraits.tsx";
import { portraitStatusLabel, portraitStatusLine } from "../settings/portraits.ts";
import { useSetting, useSettings } from "../settings/settings.ts";
import { useNotReached } from "../signin/hooks.ts";
import { COLUMN, KINDS } from "./Choose.tsx";
import { CompositionChoice } from "./CompositionChoice.tsx";
import { LookChoice } from "./LookChoice.tsx";
import { artStatusQuery } from "./queries.ts";
import { ReasoningSelect, useEffortChoice } from "./ReasoningSelect.tsx";
import { REQUEST_FIELD } from "./request-field.ts";
import { useCreator } from "./session.ts";
import { inTransition, kindTransition } from "./transition.ts";
import { WorkflowSelect } from "./WorkflowSelect.tsx";

const COPY: Record<CreatorKind, { heading: string; placeholder: string; create: string }> = {
  subject: {
    heading: "Who do you want to meet?",
    placeholder:
      "A lighthouse keeper's daughter in her thirties who has never left the island. Sharp-tongued, quietly kind, and writing letters to a stranger on the mainland she has never met.",
    create: "Create character",
  },
  group: {
    heading: "Who do you want to meet?",
    placeholder:
      "Two sisters who run a failing vineyard in the hills, one back from ten years in the city, one who never left. They love each other and keep score of everything.",
    create: "Create characters",
  },
  scenario: {
    heading: "Where do you want to go?",
    placeholder:
      "A rain-soaked harbour town in the 1920s, where a smuggler, a tired harbour master and a newly arrived detective all want the same ledger. Slow-burning, foggy, morally grey.",
    create: "Create scenario",
  },
};

/**
 * The models to write with: the listed ones, the saved one even when the list
 * failed or omits it, and `chosen`, the owner's pick in this surface, which
 * may be a typed model the list omits. Null `chosen` follows the saved model.
 * `unavailable` says why no model is chosen yet, when none can be; typing a
 * model ID in the picker still chooses one.
 */
export function useModelChoice(chosen: string | null) {
  const saved = useSetting((settings) => settings.model);
  const models = useQuery(modelsQuery);
  const listed = useModelOptions(saved);
  const options = chosen === null || listed.includes(chosen) ? listed : [...listed, chosen];
  const model = chosen ?? saved ?? listed[0] ?? null;
  const unavailable =
    model !== null || models.isPending
      ? null
      : models.isError
        ? "The model list didn't load. Type a model ID under Model to write with it."
        : "The provider lists no models. Type a model ID under Model to write with it.";
  return { options, model, unavailable };
}

/**
 * State 2: the chosen kind as a control (with Change), one large field, the
 * model, its reasoning effort, the persona {{user}} is, the portrait
 * workflow when ComfyUI is set and the portrait status in one quiet row,
 * and Create.
 */
export function Describe() {
  const kind = useCreator((state) => state.kind) ?? "subject";
  const description = useCreator((state) => state.description);
  const setDescription = useCreator((state) => state.setDescription);
  const setModel = useCreator((state) => state.setModel);
  const setReasoning = useCreator((state) => state.setReasoning);
  const composition = useCreator((state) => state.artComposition);
  const setComposition = useCreator((state) => state.setArtComposition);
  const look = useCreator((state) => state.artLook);
  const setLook = useCreator((state) => state.setArtLook);
  const change = useCreator((state) => state.change);
  const create = useCreator((state) => state.create);
  const { options, model, unavailable } = useModelChoice(useCreator((state) => state.model));
  const { efforts, effort } = useEffortChoice(
    model,
    useCreator((state) => state.reasoning),
  );
  // What the picker shows: a saved persona the list has not confirmed is not sent.
  const personaId = useChatPersona()?.id ?? null;
  const field = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  const modelLabel = useId();
  const reasoningLabel = useId();
  const personaLabel = useId();
  const workflowLabel = useId();
  const portraits = useSetting((settings) => settings.comfyuiBaseUrl) !== "";
  const reason = useId();
  const copy = COPY[kind];
  const { label, Icon } = KINDS[kind];
  const ready = description.trim() !== "" && model !== null;

  useEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, []);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (ready) inTransition(() => create(model, effort, personaId));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = isComposing(event);
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !composing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      aria-labelledby={`${fieldId}-heading`}
      onSubmit={submit}
      className={`${COLUMN} grid gap-5 pt-6 pb-16 tablet:pt-10`}
    >
      <div className="flex items-center gap-1">
        <span
          className="flex w-fit items-center gap-2 font-semibold text-ink text-ui"
          style={{ viewTransitionName: kindTransition(kind) }}
        >
          <Icon size={20} className="text-narration" />
          {label}
        </span>
        <Button
          className="h-8 px-2 text-note touch:h-11"
          aria-label={`Change from ${label}`}
          onClick={() => inTransition(change)}
        >
          Change
        </Button>
      </div>
      <h2
        id={`${fieldId}-heading`}
        className="font-semibold text-ink text-title-phone tablet:text-title"
      >
        <label htmlFor={fieldId}>{copy.heading}</label>
      </h2>
      <textarea
        ref={field}
        id={fieldId}
        data-lamp-field=""
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={copy.placeholder}
        maxLength={CREATOR_LIMITS.descriptionLength}
        autoComplete="off"
        translate="no"
        aria-describedby={unavailable === null ? undefined : reason}
        className={cn(REQUEST_FIELD, "max-h-[min(28rem,42dvh)] min-h-[calc(6*1.75rem+1.5rem)]")}
      />
      <div className="flex flex-col gap-3 tablet:flex-row tablet:items-start tablet:justify-between">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
          <span id={modelLabel} className="font-medium text-ink text-ui">
            Model
          </span>
          <ModelSelect labelId={modelLabel} options={options} value={model} onChange={setModel} />
          <span id={reasoningLabel} className="font-medium text-ink text-ui">
            Reasoning
          </span>
          <ReasoningSelect
            labelId={reasoningLabel}
            efforts={efforts}
            effort={effort}
            onChange={setReasoning}
          />
          <span id={personaLabel} className="font-medium text-ink text-ui">
            Persona
          </span>
          <PersonaSelect labelId={personaLabel} size="row" />
          {portraits && (
            <>
              <span id={workflowLabel} className="font-medium text-ink text-ui">
                Workflow
              </span>
              <WorkflowSelect labelId={workflowLabel} />
              {kind === "subject" && (
                <CompositionChoice
                  value={composition}
                  onChange={setComposition}
                  labelClassName="font-medium text-ink text-ui"
                />
              )}
              {kind !== "scenario" && (
                <LookChoice
                  value={look}
                  onChange={setLook}
                  labelClassName="font-medium text-ink text-ui"
                  className="w-full max-w-72 tablet:w-64"
                />
              )}
            </>
          )}
        </div>
        <PortraitAvailability />
      </div>
      {unavailable !== null && (
        <p id={reason} className="text-ember text-note">
          {unavailable}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={!ready}>
          {copy.create}
        </Button>
      </div>
    </form>
  );
}

/** "Portraits available" with its state dot; the engine and host open on request. */
function PortraitAvailability() {
  const { comfyuiBaseUrl, comfyuiWorkflow } = useSettings();
  const status = useQuery(artStatusQuery(comfyuiWorkflow));
  const notReached = useNotReached();
  if (status.isPending) {
    return <span className="text-note text-reed">Checking portraits…</span>;
  }
  const line = status.isSuccess ? portraitStatusLine(status.data) : null;
  const host = comfyuiBaseUrl === "" ? null : new URL(comfyuiBaseUrl).host;
  return (
    <Popover>
      <PopoverTrigger
        render={<Button className="-mx-2 h-8 gap-2 px-2 text-note touch:h-11" />}
        aria-label={`${status.isSuccess ? portraitStatusLabel(status.data) : "Portraits unknown"}: details`}
      >
        <StatusDot tone={line?.tone ?? "unknown"} />
        {status.isSuccess ? portraitStatusLabel(status.data) : "Portraits unknown"}
      </PopoverTrigger>
      <PopoverContent title="Portraits" align="end">
        <div className="grid gap-3 p-2.5 text-note">
          <p className={line?.tone === "problem" ? "text-ember" : "text-ink"}>
            {line?.text ?? `The status could not be checked: ${notReached}.`}
          </p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="text-reed">Engine</dt>
            <dd className="text-ink">ComfyUI</dd>
            <dt className="text-reed">Host</dt>
            <dd className="break-words text-ink">{host ?? "None set"}</dd>
          </dl>
          {line?.missing && (
            <p className="break-words text-reed">
              Missing: {[...line.missing.nodes, ...line.missing.models].join(", ")}
            </p>
          )}
          <Link
            to="/settings"
            className={cn(buttonVariants({ variant: "outline" }), "h-8 w-fit text-note touch:h-11")}
          >
            Portrait settings
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
