import { createFileRoute, redirect } from "@tanstack/react-router";

import { getCurrentSessionFn } from "@/server/session";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const session = await getCurrentSessionFn();
    if (session) {
      throw redirect({ to: "/mail" });
    }
    throw redirect({ to: "/sign-in" });
  },
  component: Home,
});

function Home() {
  return null;
}
