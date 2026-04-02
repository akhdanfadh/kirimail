import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";

import { MailContent } from "@/components/mail-content";
import { MailList } from "@/components/mail-list";
import { MailSidebar } from "@/components/mail-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
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
      <main className="relative flex w-full flex-1 flex-col bg-background">
        {/* Mobile: mail list only. Desktop: mail list (fixed size) + email detail side by side */}
        <div className="flex h-svh flex-col md:grid md:grid-cols-[360px_1fr]">
          <MailList />
          <MailContent activeView={activeView} />
        </div>
      </main>
    </SidebarProvider>
  );
}
