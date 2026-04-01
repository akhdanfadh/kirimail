import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Mails } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
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
  const navigate = useNavigate();
  const { session } = Route.useRouteContext();
  const [isPending, setIsPending] = useState(false);

  const onSignOut = async () => {
    setIsPending(true);
    await authClient.signOut();
    setIsPending(false);

    await navigate({ to: "/sign-in" });
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center gap-6 px-4 py-10">
      <h1 className="flex items-center gap-2 self-start text-xl font-semibold">
        <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Mails className="size-4" />
        </div>
        Kirimail
      </h1>
      <p className="text-muted-foreground">
        Signed in as {session.user.email}. Protected app shell is active.
      </p>
      <div>
        <Button onClick={onSignOut} disabled={isPending}>
          {isPending ? "Signing out..." : "Sign Out"}
        </Button>
      </div>
    </main>
  );
}
