import { ChevronRight, Mailbox as MailboxIcon } from "lucide-react";

import { IconWithBadge } from "@/components/sidebar/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { getAccountDisplayName, type EmailAccount, type Mailbox } from "@/lib/mock-data";

/** A single mailbox row (Inbox, Sent, Drafts, etc.). Multi-account profiles
 * get a collapsible row with per-account children and individual unread counts;
 * single-account profiles render a flat row. */
export function MailboxItem({
  mailbox,
  activeView,
  onViewChange,
  profileAccounts,
}: {
  mailbox: Mailbox;
  activeView: string;
  onViewChange: (id: string) => void;
  profileAccounts: EmailAccount[];
}) {
  const Icon = mailbox.icon;
  const isMultiAccount = profileAccounts.length > 1;
  const totalUnread = profileAccounts.reduce(
    (sum, acct) => sum + (mailbox.unreadByAccount[acct.id] ?? 0),
    0,
  );

  // Flat row for single-account profiles; collapsible with per-account children otherwise
  if (!isMultiAccount) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={mailbox.label}
          isActive={activeView === mailbox.id}
          onClick={() => onViewChange(mailbox.id)}
        >
          <IconWithBadge show={totalUnread > 0}>
            <Icon />
          </IconWithBadge>
          <span className={`truncate ${totalUnread > 0 ? "font-semibold" : ""}`}>
            {mailbox.label}
          </span>
          {totalUnread > 0 && (
            <span className="shrink-0 text-xs text-sidebar-foreground/80">{totalUnread}</span>
          )}
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  return (
    <Collapsible>
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={mailbox.label}
          isActive={activeView === mailbox.id}
          onClick={() => onViewChange(mailbox.id)}
        >
          <IconWithBadge show={totalUnread > 0}>
            <Icon />
          </IconWithBadge>
          <span className={`truncate ${totalUnread > 0 ? "font-semibold" : ""}`}>
            {mailbox.label}
          </span>
          {totalUnread > 0 && (
            <span className="shrink-0 text-xs text-sidebar-foreground/80">{totalUnread}</span>
          )}
        </SidebarMenuButton>
        <CollapsibleTrigger render={<SidebarMenuAction />}>
          <ChevronRight className="transition-transform duration-100 in-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {[...profileAccounts]
              .sort((a, b) => getAccountDisplayName(a).localeCompare(getAccountDisplayName(b)))
              .map((acct) => {
                const acctUnread = mailbox.unreadByAccount[acct.id] ?? 0;
                return (
                  <SidebarMenuSubItem key={acct.id}>
                    <SidebarMenuSubButton
                      render={<button type="button" />}
                      tooltip={`${mailbox.label}/${getAccountDisplayName(acct)}`}
                      isActive={activeView === `${mailbox.id}:${acct.id}`}
                      onClick={() => onViewChange(`${mailbox.id}:${acct.id}`)}
                    >
                      <IconWithBadge show={acctUnread > 0}>
                        <MailboxIcon />
                      </IconWithBadge>
                      <span className={`truncate ${acctUnread > 0 ? "font-semibold" : ""}`}>
                        {getAccountDisplayName(acct)}
                      </span>
                      {acctUnread > 0 && (
                        <span className="shrink-0 text-xs text-sidebar-foreground/80">
                          {acctUnread}
                        </span>
                      )}
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                );
              })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}
