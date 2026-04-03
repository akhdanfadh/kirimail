import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";

import { MailContent } from "@/components/mail-content";
import { MailList } from "@/components/mail-list";
import { MailSidebar } from "@/components/mail-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { getCurrentSessionFn } from "@/server/session";

export const Route = createFileRoute("/mail")({
  beforeLoad: async ({ location }) => {
    const session = await getCurrentSessionFn();
    if (!session) {
      throw redirect({
        to: "/sign-in",
        search: { redirect: location.href },
      });
    }
    return { session };
  },
  component: AppPage,
});

function AppPage() {
  const { session } = Route.useRouteContext();
  const [activeView, setActiveView] = useState("inbox");
  const [activeProfileId, setActiveProfileId] = useState("profile-1");

  return (
    <SidebarProvider>
      <MailSidebar
        activeView={activeView}
        onViewChange={setActiveView}
        activeProfileId={activeProfileId}
        onProfileChange={setActiveProfileId}
        session={session}
      />
      <SidebarInset>
        <MailLayout activeView={activeView} />
      </SidebarInset>
    </SidebarProvider>
  );
}

/** Bridges the outer nav sidebar context with a collapsible mail list panel.
 * Desktop: inline panel with width transition. Mobile: stacked layout. */
function MailLayout({ activeView }: { activeView: string }) {
  const [listOpen, setListOpen] = useState(true);
  const toggleList = () => setListOpen((prev) => !prev);

  return (
    <div className="flex h-svh flex-col md:flex-row">
      {/* Mobile: mail list always visible, full width */}
      <div className="flex-1 md:hidden">
        <MailList />
      </div>

      {/* Desktop: collapsible mail list panel */}
      <div
        className={cn(
          "hidden shrink-0 overflow-hidden transition-[width] duration-200 ease-linear md:block",
          listOpen ? "w-90" : "w-0",
        )}
      >
        <div className="h-full w-90 border-r">
          <MailList />
        </div>
      </div>

      {/* Desktop: content panel (hidden on mobile), for now... */}
      <MailContent activeView={activeView} listOpen={listOpen} listToggle={toggleList} />
    </div>
  );
}
