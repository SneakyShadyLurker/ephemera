import { type CharacterSummary, hasTag } from "@ephemera/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useRef, useState, ViewTransition } from "react";
import { useShallow } from "zustand/shallow";
import { HeaderAction, ListLoadFailed, PortraitTile } from "@/app/Browse.tsx";
import { ChoiceList } from "@/app/ChoicePicker.tsx";
import { EmptyState } from "@/app/EmptyState.tsx";
import { useFormFactor } from "@/app/form-factor.ts";
import { importProgress } from "@/app/importing";
import { KeptScroll } from "@/app/KeptScroll.tsx";
import { InlineStatus } from "@/app/NoticeCard.tsx";
import {
  BROWSE_BODY,
  BROWSE_FRAME,
  BROWSE_GRID,
  PAGE_FRAME,
  SCROLL_GUTTERS,
  ScreenHeader,
} from "@/app/Screen.tsx";
import { DropOverlay, useFileDrop } from "@/components/file-drop";
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  ImportIcon,
  LampFlameIcon,
  PlusIcon,
  SortIcon,
  TagIcon,
} from "@/components/icons";
import { Illustration } from "@/components/illustration.tsx";
import { hasReport, ReportGroups } from "@/components/import-report";
import { Button, buttonVariants } from "@/components/ui/button";
import { Unfold } from "@/components/ui/disclosure";
import {
  Drawer,
  DrawerCloseIcon,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioSegment, RadioSegments } from "@/components/ui/radio-group";
import { SearchField } from "@/components/ui/search-field";
import { cn } from "@/lib/cn";
import { fold } from "@/lib/find";
import { useStartChat } from "../chat/StartChat.tsx";
import { KeptNote } from "../creator/KeptNote.tsx";
import { filterCharacters, type Order, repeatedNames, tagCounts } from "./filter.ts";
import {
  clearFilters,
  filtersOf,
  REORDER,
  setOpened,
  setOrder,
  setQuery,
  toggleTag,
  useGallery,
  useShownFilters,
} from "./gallery-state.ts";
import { CARD_FILE_TYPES, cardImports, importCards } from "./importing.ts";
import { charactersQuery } from "./queries.ts";

const ORDERS: { value: Order; label: string }[] = [
  { value: "recent", label: "Recently edited" },
  { value: "name", label: "Name" },
];

export function GalleryScreen() {
  const phone = useFormFactor() === "phone";
  const characters = useQuery(charactersQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const picker = useRef<HTMLInputElement>(null);

  const openPicker = () => picker.current?.click();
  const importFiles = (files: File[]) => {
    if (files.length > 0) void importCards(files, queryClient);
  };
  const newCharacter = () => void navigate({ to: "/characters/$id", params: { id: "new" } });
  const createWithAi = () => void navigate({ to: "/characters/create" });
  // One start for every tile's Chat, and one confirmation.
  const { start, dialog } = useStartChat();

  const { dragging, dropTarget } = useFileDrop(importFiles);

  const list = characters.data ?? [];
  const empty = characters.isSuccess && list.length === 0;
  // The header sits on what the body shows: the cast and an empty library share one frame.
  const frame = characters.isError ? PAGE_FRAME : BROWSE_FRAME;

  return (
    <main
      className="relative flex min-w-0 flex-1 flex-col [timeline-scope:--thread]"
      {...dropTarget}
    >
      <input
        ref={picker}
        type="file"
        multiple
        accept={CARD_FILE_TYPES}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          importFiles([...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = "";
        }}
      />
      <ScreenHeader
        collection
        title={<GalleryTitle list={list} />}
        frame={frame}
        gutters={SCROLL_GUTTERS}
      >
        <HeaderAction
          label="Import cards"
          text="Import"
          labelledOnPhone
          icon={ImportIcon}
          onClick={openPicker}
        />
        <HeaderAction
          label="New character"
          text="New"
          labelledOnPhone
          icon={PlusIcon}
          onClick={newCharacter}
        />
        <HeaderAction
          label="Create with AI"
          labelledOnPhone
          icon={LampFlameIcon}
          onClick={createWithAi}
        />
      </ScreenHeader>
      <div
        data-skip-target=""
        tabIndex={-1}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto outline-none [scroll-timeline:--thread]",
          SCROLL_GUTTERS,
        )}
      >
        <KeptScroll id="characters" ready={characters.data !== undefined && !characters.isError} />
        {characters.isError ? (
          <ListLoadFailed what="Characters" onRetry={() => void characters.refetch()} />
        ) : empty ? (
          <EmptyGallery phone={phone} onImport={openPicker} onCreate={createWithAi} />
        ) : (
          // A container, so the cards' minimum grows with the space (`cqi`).
          <div className={cn(BROWSE_BODY, BROWSE_FRAME, BROWSE_BODY)}>
            <Toolbar list={list} phone={phone} />
            <KeptNote />
            <ImportReport />
            <Cast list={list} pending={characters.isPending} onChat={start} />
          </div>
        )}
      </div>
      {dialog}
      <DropOverlay
        shown={dragging}
        title="Drop cards to import"
        hint="SillyTavern or Ephemera character cards, as PNG or JSON"
      />
    </main>
  );
}

/** "Characters" with the count; while filtering, "2 of 9", also announced politely. */
function GalleryTitle({ list }: { list: CharacterSummary[] }) {
  const { query, tags, order } = useGallery(useShallow(filtersOf));
  const shown = filterCharacters(list, { query, tags, order }).length;
  const filtering = query.trim() !== "" || tags.length > 0;
  const count = filtering ? `${shown} of ${list.length}` : String(list.length);
  return (
    <span className="flex items-baseline gap-2">
      Characters
      {list.length > 0 && (
        <span className="font-normal text-meta text-reed tabular-nums">{count}</span>
      )}
      <span role="status" className="sr-only">
        {filtering ? `${count} characters` : ""}
      </span>
    </span>
  );
}

function Toolbar({ list, phone }: { list: CharacterSummary[]; phone: boolean }) {
  const query = useGallery((state) => state.query);
  const tags = useGallery((state) => state.tags);
  return (
    <div className="grid gap-3">
      {/* On phones the search takes its own row, so the row is never wider than the screen. */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchField
          label="Search characters"
          placeholder="Search by name, tag or creator"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="flex-1 basis-full tablet:max-w-sm tablet:basis-0"
        />
        {phone ? (
          <FilterSheet list={list} />
        ) : (
          <>
            <TagPopover list={list} />
            <OrderMenu />
          </>
        )}
      </div>
      {tags.length > 0 && (
        <ul
          aria-label="Active tag filters"
          className="flex flex-wrap items-center gap-1.5 transition-opacity duration-(--duration-quick) ease-fade starting:opacity-0"
        >
          {tags.map((tag) => (
            <li key={tag} className="arrive">
              <button
                type="button"
                aria-label={`Remove tag filter ${tag}`}
                onClick={() => toggleTag(tag)}
                className="press flex h-8 items-center gap-1 rounded-md bg-surface-selected pr-1.5 pl-2.5 text-ink text-note hover:bg-surface-pressed touch:h-11 touch:pr-3 touch:pl-3.5"
              >
                {tag}
                <CloseIcon size={16} className="text-reed" />
              </button>
            </li>
          ))}
          <li>
            <Button size="text" onClick={clearFilters}>
              Clear filters
            </Button>
          </li>
        </ul>
      )}
    </div>
  );
}

function TagList({ list }: { list: CharacterSummary[] }) {
  const selected = useGallery((state) => state.tags);
  return (
    <ChoiceList
      compact
      findLabel="Find a tag"
      empty="No tags yet."
      noMatch="No tag matches."
      choices={tagCounts(list).map(([tag, count]) => ({
        id: tag,
        name: tag,
        count,
        checked: hasTag(selected, tag),
      }))}
      onToggle={(choice) => toggleTag(choice.id)}
    />
  );
}

function TagPopover({ list }: { list: CharacterSummary[] }) {
  const active = useGallery((state) => state.tags.length);
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="outline" className={cn(active > 0 && "border-ink")} />}
      >
        <TagIcon size={16} />
        Tags
        {active > 0 && <span className="text-meta text-reed tabular-nums">{active}</span>}
        <ChevronDownIcon size={16} className="text-reed" />
      </PopoverTrigger>
      <PopoverContent title="Filter by tag">
        <TagList list={list} />
        <p className="border-rush border-t px-2.5 pt-2 pb-1.5 text-meta text-reed">
          Shows characters with every checked tag.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function OrderMenu() {
  const order = useGallery((state) => state.order);
  const label = ORDERS.find((option) => option.value === order)?.label;
  return (
    <Menu>
      <MenuTrigger render={<Button className="ml-auto" aria-label={`Order: ${label}`} />}>
        <SortIcon size={16} />
        {label}
        <ChevronDownIcon size={16} className="text-reed" />
      </MenuTrigger>
      <MenuContent label="Order">
        <MenuRadioGroup value={order} onValueChange={(value) => setOrder(value as Order)}>
          {ORDERS.map(({ value, label: text }) => (
            // Choosing an order is a one-off: close like a plain item (radio items stay open by default).
            <MenuRadioItem key={value} value={value} closeOnClick>
              {text}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

/** Phones: tags and order in the bottom-sheet grammar, closed like every sheet. */
function FilterSheet({ list }: { list: CharacterSummary[] }) {
  const [open, setOpen] = useState(false);
  const active = useGallery((state) => state.tags.length);
  const order = useGallery((state) => state.order);
  const orderId = useId();
  return (
    <>
      <Button
        variant="outline"
        size="icon"
        aria-label={active > 0 ? `Filter and order, ${active} tags checked` : "Filter and order"}
        className={cn(active > 0 && "border-ink")}
        onClick={() => setOpen(true)}
      >
        <TagIcon size={16} />
      </Button>
      <Drawer open={open} onOpenChange={setOpen} showSwipeHandle>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Filter and order</DrawerTitle>
            <DrawerCloseIcon label="Close filter and order" />
          </DrawerHeader>
          <div className="flex min-h-0 flex-col pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            <div className="grid gap-2 px-5 pb-3">
              <span id={orderId} className="font-medium text-ink text-ui">
                Order
              </span>
              <RadioSegments<Order>
                aria-labelledby={orderId}
                value={order}
                onValueChange={(value) => setOrder(value)}
                className="grid-cols-2"
              >
                {ORDERS.map(({ value, label }) => (
                  <RadioSegment key={value} value={value}>
                    {label}
                  </RadioSegment>
                ))}
              </RadioSegments>
            </div>
            <span className="px-5 font-medium text-ink text-ui">Tags</span>
            <div className="flex min-h-0 flex-col px-3">
              <TagList list={list} />
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}

/** One quiet line on the grid; the per-file details open on request. */
function ImportReport() {
  const report = cardImports.use((state) => state.report);
  const importing = cardImports.use((state) => state.importing);
  const [details, setDetails] = useState(false);
  const detailsId = useId();
  if (importing !== null) {
    return (
      <InlineStatus as="p" role="status">
        {importProgress(importing)}
      </InlineStatus>
    );
  }
  if (report.length === 0) return null;
  const imported = report.flatMap((outcome) => (outcome.ok ? [outcome] : []));
  const failed = report.flatMap((outcome) => (outcome.ok ? [] : [outcome]));
  const summary =
    imported.length === 1
      ? `Imported ${imported[0]?.name}.`
      : imported.length > 0
        ? `Imported ${imported.length} cards.`
        : "";
  const changed = imported.some(
    ({ report }) => report.changed.length > 0 || report.skipped.length > 0,
  );
  const failures =
    failed.length === 0
      ? ""
      : failed.length === 1
        ? `${failed[0]?.file} was not imported: ${failed[0]?.reason}.`
        : `${failed.length} were not imported.`;
  return (
    <InlineStatus as="div" role="status" className="grid text-ui arrive">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui">
        {imported.length > 0 && <CheckIcon size={16} className="text-reed" />}
        <p className="text-reed">
          {summary}
          {changed && <span className="text-reed"> Some settings changed or were left out.</span>}{" "}
          {failures && <span className="text-ember">{failures}</span>}
        </p>
        {(failed.length > 1 || imported.some(({ report }) => hasReport(report))) && (
          <Button
            size="text"
            aria-expanded={details}
            aria-controls={detailsId}
            onClick={() => setDetails(!details)}
          >
            {details ? "Hide details" : "Show details"}
          </Button>
        )}
        <Button size="text" onClick={() => cardImports.dismiss()}>
          Dismiss
        </Button>
      </div>
      {imported.length > 0 && (
        <div className="flex flex-wrap gap-2 pb-1">
          {imported.map((card) => (
            <Link
              key={card.id}
              to="/characters/$id"
              params={{ id: card.id }}
              className={buttonVariants({
                variant: "outline",
                size: "text",
                className: "min-w-0 max-w-full",
              })}
            >
              <span className="truncate">Open {card.name}</span>
            </Link>
          ))}
        </div>
      )}
      <Unfold show={details} id={detailsId}>
        <div className="grid gap-2 pt-2">
          {imported.map(
            (outcome) =>
              hasReport(outcome.report) && (
                <div key={outcome.id} className="grid gap-3 border-rush border-l pl-4 text-ui">
                  <p className="font-medium text-ink">{outcome.name}</p>
                  <ReportGroups report={outcome.report} />
                </div>
              ),
          )}
          {failed.length > 0 && (
            <ul className="grid max-h-48 gap-1 overflow-y-auto border-rush border-l pl-4 text-ui">
              {failed.map((outcome) => (
                <li key={outcome.key} className="text-reed">
                  <span className="text-ink">{outcome.file}</span>: {outcome.reason}.
                </li>
              ))}
            </ul>
          )}
        </div>
      </Unfold>
    </InlineStatus>
  );
}

function Cast({
  list,
  pending,
  onChat,
}: {
  list: CharacterSummary[];
  pending: boolean;
  /** Starts a chat with the character, asking first when that clears the open chat. */
  onChat: (id: string, name: string) => void;
}) {
  const { query, tags, order } = useShownFilters();
  const arrived = useGallery((state) => state.arrived);
  const opened = useGallery((state) => state.opened);
  const shown = filterCharacters(list, { query, tags, order });
  const repeated = repeatedNames(list);
  if (pending) return null;
  if (shown.length === 0) {
    return (
      <EmptyState
        compact
        title="No characters match."
        actions={
          <Button variant="outline" onClick={clearFilters}>
            Clear filters
          </Button>
        }
      />
    );
  }
  return (
    <ul aria-label="Characters" className={BROWSE_GRID}>
      {shown.map((character) => (
        // A new order or tag filter glides each card to its place; nothing else animates it.
        <ViewTransition
          key={character.id}
          default="none"
          update={{ [REORDER]: "glide", default: "none" }}
          enter={{ [REORDER]: "glide", default: "none" }}
          exit={{ [REORDER]: "glide", default: "none" }}
        >
          <li data-character={character.id}>
            <PortraitTile
              owner="characters"
              id={character.id}
              name={character.name}
              version={character.portrait}
              arriving={arrived.includes(character.id)}
              transition={opened === character.id}
              onOpen={() => setOpened(character.id)}
              onChat={() => onChat(character.id, character.name)}
              caption={[
                repeated.has(fold(character.name)) ? character.creator : "",
                character.tags.join(", "),
              ]
                .filter(Boolean)
                .join("; ")}
            />
          </li>
        </ViewTransition>
      ))}
    </ul>
  );
}

/**
 * Empty library: import is the first step (most stories start from a card
 * already made), with the drop hint where dropping works; New character and
 * Create with AI stay in the header.
 */
function EmptyGallery({
  phone,
  onImport,
  onCreate,
}: {
  phone: boolean;
  onImport: () => void;
  onCreate: () => void;
}) {
  return (
    <div className={BROWSE_FRAME}>
      {/* A failed import into an empty library still reports why. */}
      <div className="pt-3 empty:hidden">
        <ImportReport />
      </div>
      <EmptyState
        title="No characters yet"
        art={{ role: "hero", image: <Illustration name="empty-characters" /> }}
        actions={
          <>
            <Button variant="primary" onClick={onImport}>
              <ImportIcon size={16} />
              Import
            </Button>
            <Button variant="quiet" onClick={onCreate}>
              <LampFlameIcon size={16} />
              Create with AI
            </Button>
          </>
        }
      >
        Import a character card as PNG or JSON{phone ? "" : ", or drop cards on this page"}.
        Characters are saved; chats are not.
      </EmptyState>
    </div>
  );
}
