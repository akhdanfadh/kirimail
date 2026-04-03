import { ChevronRight, Folder as FolderIcon, Mailbox as MailboxIcon } from "lucide-react";

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
import {
  getAccountDisplayName,
  type AccountFolders,
  type EmailAccount,
  type Folder,
} from "@/lib/mock-data";

/** Recursive folder row. Folders with children become collapsible with
 * alphabetically sorted sub-items. Uses different sidebar wrapper components
 * at depth 0 vs nested depths (shadcn sidebar structural requirement). */
export function FolderItem({
  folder,
  activeView,
  onViewChange,
  depth = 0,
  tooltipPath,
}: {
  folder: Folder;
  activeView: string;
  onViewChange: (id: string) => void;
  depth?: number;
  tooltipPath?: string;
}) {
  const Icon = folder.icon ?? FolderIcon;
  const hasChildren = folder.children && folder.children.length > 0;
  const currentPath = tooltipPath ? `${tooltipPath}/${folder.label}` : folder.label;

  if (!hasChildren) {
    // shadcn sidebar uses SidebarMenuItem at top level, SidebarMenuSubItem when nested
    if (depth === 0) {
      return (
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip={currentPath}
            isActive={activeView === folder.id}
            onClick={() => onViewChange(folder.id)}
          >
            <IconWithBadge show={folder.unread > 0}>
              <Icon />
            </IconWithBadge>
            <span className={`truncate ${folder.unread > 0 ? "font-semibold" : ""}`}>
              {folder.label}
            </span>
            {folder.unread > 0 && (
              <span className="shrink-0 text-xs text-sidebar-foreground/80 tabular-nums">
                {folder.unread}
              </span>
            )}
          </SidebarMenuButton>
        </SidebarMenuItem>
      );
    }
    return (
      <SidebarMenuSubItem>
        <SidebarMenuSubButton
          render={<button type="button" />}
          tooltip={currentPath}
          isActive={activeView === folder.id}
          onClick={() => onViewChange(folder.id)}
        >
          <IconWithBadge show={folder.unread > 0}>
            <Icon />
          </IconWithBadge>
          <span className={`truncate ${folder.unread > 0 ? "font-semibold" : ""}`}>
            {folder.label}
          </span>
          {folder.unread > 0 && (
            <span className="shrink-0 text-xs text-sidebar-foreground/80 tabular-nums">
              {folder.unread}
            </span>
          )}
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    );
  }

  return (
    <Collapsible>
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={currentPath}
          isActive={activeView === folder.id}
          onClick={() => onViewChange(folder.id)}
        >
          <IconWithBadge show={folder.unread > 0}>
            <Icon />
          </IconWithBadge>
          <span className={`truncate ${folder.unread > 0 ? "font-semibold" : ""}`}>
            {folder.label}
          </span>
          {folder.unread > 0 && (
            <span className="shrink-0 text-xs text-sidebar-foreground/80 tabular-nums">
              {folder.unread}
            </span>
          )}
        </SidebarMenuButton>
        <CollapsibleTrigger render={<SidebarMenuAction />}>
          <ChevronRight className="transition-transform duration-200 in-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {[...folder.children!]
              .sort((a, b) => a.label.localeCompare(b.label))
              .map((child) => (
                <FolderItem
                  key={child.id}
                  folder={child}
                  activeView={activeView}
                  onViewChange={onViewChange}
                  depth={depth + 1}
                  tooltipPath={currentPath}
                />
              ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

/** Collapsible account-level folder tree. Shows the account display name as
 * the parent row with provider-native folders nested underneath. */
export function FolderTree({
  accountFolders,
  accounts,
  activeView,
  onViewChange,
}: {
  accountFolders: AccountFolders;
  accounts: EmailAccount[];
  activeView: string;
  onViewChange: (id: string) => void;
}) {
  const acct = accounts.find((a) => a.id === accountFolders.accountId);
  const displayName = acct ? getAccountDisplayName(acct) : accountFolders.accountId;

  return (
    <Collapsible defaultOpen>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip={displayName}>
          <MailboxIcon />
          <span className="truncate">{displayName}</span>
        </SidebarMenuButton>
        <CollapsibleTrigger render={<SidebarMenuAction />}>
          <ChevronRight className="transition-transform duration-200 in-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {[...accountFolders.folders]
              .sort((a, b) => a.label.localeCompare(b.label))
              .map((folder) => (
                <FolderItem
                  key={folder.id}
                  folder={folder}
                  activeView={activeView}
                  onViewChange={onViewChange}
                  depth={1}
                  tooltipPath={displayName}
                />
              ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}
