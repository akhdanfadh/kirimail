import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export function MailContent({
  activeView,
  listOpen,
  listToggle,
}: {
  activeView: string;
  listOpen: boolean;
  listToggle: () => void;
}) {
  return (
    <section className="hidden min-h-0 min-w-0 flex-1 flex-col md:flex">
      <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b px-3">
        <Button
          variant="outline"
          size="icon-sm"
          className="cursor-pointer"
          onClick={listToggle}
          aria-label={listOpen ? "Hide mail list" : "Show mail list"}
        >
          {listOpen ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
        </Button>
        <p className="text-muted-foreground">Actions</p>
      </header>
      <div className="flex-1 overflow-auto p-6">
        <h2 className="text-3xl font-semibold tracking-tight">Subject</h2>
        <Separator className="my-6" />
        <p className="text-muted-foreground">
          Active view: <code className="rounded bg-muted px-1 py-0.5">{activeView}</code>.
        </p>
      </div>
    </section>
  );
}
