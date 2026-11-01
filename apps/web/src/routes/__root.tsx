import { CSPProvider } from "@base-ui/react/csp-provider";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { useFormFactor } from "@/app/form-factor.ts";
import { NavSheet, Rail } from "@/app/Navigation.tsx";
import { NotFoundScreen, SkipToContent } from "@/app/Screen.tsx";
import { ThemeProvider } from "@/app/theme.tsx";
import { UpdateFloat } from "@/app/UpdateFloat.tsx";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SettingsSaveFloat } from "../settings/SaveFloat.tsx";
import { settingsQuery } from "../settings/settings.ts";
import { SignInFloat } from "../signin/SignInSlots.tsx";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // The saved selection and theme are there before the first render; a server that
  // cannot answer leaves the tab on the fallback settings instead of an error screen.
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(settingsQuery).catch(() => undefined),
  component: AppShell,
  notFoundComponent: NotFoundScreen,
});

function AppShell() {
  const formFactor = useFormFactor();
  return (
    // Base UI renders no style elements, so the CSP needs no inline-style allowance.
    <CSPProvider disableStyleElements>
      <ThemeProvider>
        <TooltipProvider>
          <div className="flex h-dvh overflow-clip pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
            <SkipToContent />
            {formFactor === "phone" ? <NavSheet /> : <Rail compact={formFactor === "tablet"} />}
            <div className="relative flex min-w-0 flex-1">
              <Outlet />
              {/* Over the top of the content column: a settings save that is taking a while. */}
              <div className="pointer-events-none absolute inset-x-0 top-0 z-(--z-float) flex flex-col items-center gap-2 px-5 pt-[calc(0.75rem+env(safe-area-inset-top))] tablet:px-6 tablet:pt-6">
                <SettingsSaveFloat />
              </div>
              {/* Over the bottom, clear of the headings: the update, then sign-in. The chat docks both above its composer. */}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-(--z-float) flex flex-col items-center gap-2 px-5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] tablet:px-6 tablet:pb-6">
                <UpdateFloat />
                <SignInFloat />
              </div>
            </div>
          </div>
        </TooltipProvider>
      </ThemeProvider>
    </CSPProvider>
  );
}
