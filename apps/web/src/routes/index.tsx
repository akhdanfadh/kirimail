import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main>
      <h1>Kirimail</h1>
      <p>Phase 1 bootstrap: web app slice is running.</p>
    </main>
  );
}
