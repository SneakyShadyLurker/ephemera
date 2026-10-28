import type { PersonaSummary } from "@ephemera/core";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { HeaderAction, ListLoadFailed, PortraitTile } from "@/app/Browse.tsx";
import { KeptScroll } from "@/app/KeptScroll.tsx";
import {
  BROWSE_FRAME,
  BROWSE_GRID,
  PAGE_FRAME,
  SCROLL_GUTTERS,
  ScreenHeader,
} from "@/app/Screen.tsx";
import { MarkIcon, PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { andList } from "@/lib/text";
import { charactersQuery } from "../characters/queries.ts";
import { useSetting } from "../settings/settings.ts";
import { personasQuery } from "./queries.ts";

/**
 * The persona last opened, whose tile carries the portrait morph to and from
 * its sheet. A store, so setting it re-renders the tile before the route's
 * view transition captures it, as the character gallery does.
 */
const openedPersona = createStore<string | null>()(() => null);
export const setOpenedPersona = (id: string | null) => openedPersona.setState(id, true);

/** "Mara Voss", "Mara Voss and Wren", "Mara Voss, Wren and Tobias Hale". */
export function PersonasScreen() {
  const navigate = useNavigate();
  const personas = useQuery(personasQuery);
  const list = personas.data ?? [];
  const empty = personas.isSuccess && list.length === 0;
  // The header sits on what the body shows: the cast, or the page column when there is none.
  const frame = personas.isError || empty ? PAGE_FRAME : BROWSE_FRAME;
  const newPersona = () => void navigate({ to: "/personas/$id", params: { id: "new" } });

  return (
    <main className="flex min-w-0 flex-1 flex-col [timeline-scope:--thread]">
      <ScreenHeader
        frame={frame}
        gutters={SCROLL_GUTTERS}
        title={
          <span className="flex items-baseline gap-2">
            Personas
            {list.length > 0 && (
              <span className="font-normal text-meta text-reed tabular-nums">{list.length}</span>
            )}
          </span>
        }
      >
        <HeaderAction label="New persona" icon={PlusIcon} onClick={newPersona} />
      </ScreenHeader>
      <div
        data-skip-target=""
        tabIndex={-1}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto outline-none [scroll-timeline:--thread]",
          SCROLL_GUTTERS,
        )}
      >
        <KeptScroll id="personas" ready={personas.data !== undefined && !personas.isError} />
        {personas.isError ? (
          <ListLoadFailed what="Personas" onRetry={() => void personas.refetch()} />
        ) : empty ? (
          <EmptyPersonas onNew={newPersona} />
        ) : (
          // A container, so the cards' minimum grows with the space (`cqi`).
          <div
            className={cn(
              BROWSE_FRAME,
              "@container grid grid-cols-[minmax(0,1fr)] gap-6 pt-3 pb-10",
            )}
          >
            <p className="max-w-measure text-pretty text-note text-reed">
              Who you are in the story. New chats start as the default persona, unless the character
              goes with another.
            </p>
            <Cast list={list} />
          </div>
        )}
      </div>
    </main>
  );
}

function Cast({ list }: { list: PersonaSummary[] }) {
  const defaultPersonaId = useSetting((settings) => settings.defaultPersonaId);
  const opened = useStore(openedPersona);
  const characters = useQuery(charactersQuery);
  const nameOf = (id: string) => characters.data?.find((character) => character.id === id)?.name;
  return (
    <ul aria-label="Personas" className={BROWSE_GRID}>
      {list.map((persona) => {
        const isDefault = persona.id === defaultPersonaId;
        const bound = persona.characterIds.map(nameOf).filter((name) => name !== undefined);
        return (
          <li key={persona.id} data-persona={persona.id}>
            <PortraitTile
              owner="personas"
              id={persona.id}
              name={persona.name}
              version={persona.portrait}
              transition={opened === persona.id}
              onOpen={() => setOpenedPersona(persona.id)}
              caption={
                <>
                  {isDefault && <span className="text-ink">Default</span>}
                  {isDefault && bound.length > 0 && "; "}
                  {bound.length > 0 && `${isDefault ? "with" : "With"} ${andList(bound)}`}
                </>
              }
            />
          </li>
        );
      })}
    </ul>
  );
}

function EmptyPersonas({ onNew }: { onNew: () => void }) {
  return (
    <div
      className={cn(
        PAGE_FRAME,
        "grid pt-[12dvh] tablet:grid-cols-[7rem_minmax(0,40rem)] tablet:gap-x-6",
      )}
    >
      <div className="hidden tablet:block">
        <div className="grid aspect-[2/3] place-items-center rounded-lg border-2 border-control-edge border-dashed text-reed">
          <PlusIcon size={24} />
        </div>
      </div>
      <div className="grid content-start justify-items-start gap-3 transition-opacity duration-(--duration-arrive) ease-fade starting:opacity-0">
        <MarkIcon size={96} className="mb-2 -ml-1.5 text-reed tablet:hidden" />
        <h2 className="font-semibold text-heading text-ink">No personas yet</h2>
        <p className="max-w-empty text-pretty text-lead text-reed">
          A persona is who you are in the story: a name, a portrait and a description. Until you
          make one, your lines are cued as You.
        </p>
        <Button variant="primary" className="mt-2" onClick={onNew}>
          <PlusIcon size={16} />
          New persona
        </Button>
      </div>
    </div>
  );
}
