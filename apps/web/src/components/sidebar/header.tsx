import { Link } from "@tanstack/react-router";
import { EllipsisVertical, Mails, SquarePen } from "lucide-react";

import type { EmailAccount } from "@/lib/mock-data";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "@/components/ui/sidebar";

/** Sidebar header with logo, collapse trigger, and "New Mail" compose button.
 * When the active profile has multiple accounts, the compose button opens a
 * dropdown to pick the sending account. */
export function MailSidebarHeader({ profileAccounts }: { profileAccounts: EmailAccount[] }) {
  return (
    <SidebarHeader className="gap-0 px-0 pt-0 pb-2">
      <div className="flex h-(--header-height) items-center px-3">
        <SidebarTrigger className="shrink-0 cursor-pointer" variant="outline" />
        <Link to="/mail" className="ml-3 flex items-center gap-2 overflow-hidden">
          <Mails className="size-4 shrink-0" />
          <span className="shrink-0 text-lg font-semibold">Kirimail</span>
        </Link>
      </div>

      <SidebarMenu className="px-3">
        <SidebarMenuItem>
          {profileAccounts.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton
                    tooltip="New Mail"
                    className="bg-primary text-primary-foreground hover:bg-primary/80 hover:text-primary-foreground active:bg-primary/80 active:text-primary-foreground"
                  />
                }
              >
                <SquarePen />
                <span>New Mail</span>
                <EllipsisVertical className="ml-auto" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="start">
                {profileAccounts.map((acct) => (
                  <DropdownMenuItem key={acct.id}>
                    <span className="truncate">as {acct.email}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <SidebarMenuButton
              tooltip="New Mail"
              className="bg-primary text-primary-foreground hover:bg-primary/80 hover:text-primary-foreground active:bg-primary/80 active:text-primary-foreground"
            >
              <SquarePen />
              <span>New Mail</span>
            </SidebarMenuButton>
          )}
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
  );
}
