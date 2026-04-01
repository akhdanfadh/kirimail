import { createFileRoute, redirect } from "@tanstack/react-router";
import { Mails } from "lucide-react";
import { z } from "zod";

import { LoginForm } from "@/components/login-form";
import { getCurrentSessionFn } from "@/server/session";

export const Route = createFileRoute("/sign-in")({
  validateSearch: z.object({
    redirect: z.string().optional(),
  }),
  beforeLoad: async () => {
    const session = await getCurrentSessionFn();
    if (session) {
      throw redirect({ to: "/mail" });
    }
  },
  component: SignInPage,
});

function SignInPage() {
  const { redirect: redirectTo } = Route.useSearch();

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-medium">
          <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Mails className="size-4" />
          </div>
          Kirimail
        </div>
        <LoginForm redirectTo={redirectTo} />
      </div>
    </div>
  );
}
