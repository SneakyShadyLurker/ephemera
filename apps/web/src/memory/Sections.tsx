import { useRef } from "react";
import { scrollBehavior } from "@/app/reduced-motion.ts";
import { SectionsIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";

/** Memory's reading order, shared by the menu and the notebook's labelled targets. */
export const MEMORY_SECTIONS = {
  situation: "Situation",
  opening: "Next chat opens with",
  relationships: "Relationships",
  facts: "Facts",
  threads: "Open threads",
  cast: "Cast",
  memories: "Memories",
} as const;

export type MemorySectionKey = keyof typeof MEMORY_SECTIONS;
export type RegisterMemorySection = (key: MemorySectionKey, node: HTMLElement | null) => void;

/** Focus belongs to the group; only its visible label carries the ring. */
export const SECTION_TARGET = "group/section scroll-mt-6 outline-none";
export const SECTION_LABEL = "w-fit tablet:justify-self-end group-focus-visible/section:focus-ring";

export function MemorySectionsMenu({
  targetFor,
}: {
  targetFor: (key: MemorySectionKey) => HTMLElement | null;
}) {
  const chosen = useRef<MemorySectionKey | null>(null);
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Menu>
        <MenuTrigger
          render={<Button variant="quiet" aria-label="Go to section" className="px-2 touch:px-2" />}
        >
          <SectionsIcon size={16} />
          Sections
        </MenuTrigger>
        <MenuContent
          label="Sections"
          finalFocus={() => {
            const key = chosen.current;
            chosen.current = null;
            const target = key === null ? null : targetFor(key);
            // Resolve after close, against the current notebook revision. Off/leave can remove
            // the target meanwhile; Base UI then returns to the trigger's valid owner.
            if (!target?.isConnected || target.closest("[inert], [hidden]")) return true;
            target.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
            target.focus({ preventScroll: true });
            return false;
          }}
        >
          {Object.entries(MEMORY_SECTIONS).map(([key, label]) => (
            <MenuItem
              key={key}
              onClick={() => {
                chosen.current = key as MemorySectionKey;
              }}
            >
              {label}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </div>
  );
}
