import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@/lib/cn";

/*
 * Vertical tabs drawn as an index: a hairline rule with the names beside it,
 * quiet until active or hovered, and a 2px Ink bar on the rule that glides
 * to the active name (the character sheet's index grammar). A panel that
 * opens arrives from the side it was chosen from (`panel-arrive`); the one
 * it replaces hides at once.
 */

const Tabs = TabsPrimitive.Root;

/** The index: its names, and the bar that marks the active one. */
function TabsList({ className, children, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List className={cn("relative grid border-rush border-l", className)} {...props}>
      {children}
      <TabsPrimitive.Indicator className="absolute top-0 -left-px h-(--active-tab-height) w-0.5 translate-y-(--active-tab-top) bg-ink transition-[translate,height] duration-(--duration-panel-in) ease-spring motion-reduce:transition-none" />
    </TabsPrimitive.List>
  );
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "press py-1.5 pl-4 text-left text-note text-reed hover:text-ink data-active:text-ink touch:py-3",
        className,
      )}
      {...props}
    />
  );
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel className={cn("panel-arrive", className)} {...props} />;
}

export { Tabs, TabsList, TabsPanel, TabsTab };
