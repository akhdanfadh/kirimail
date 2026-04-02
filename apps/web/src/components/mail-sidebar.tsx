import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronRight,
  EllipsisVertical,
  Folder as FolderIcon,
  LogOut,
  Mailbox,
  Mails,
  RefreshCw,
  Settings,
  SquarePen,
  Tag as TagIcon,
} from "lucide-react";
import { useState } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";
import {
  accounts,
  accountFolders,
  getAccountDisplayName,
  profiles,
  systemFolders,
  type AccountFolders,
  type EmailAccount,
  type Folder,
  type SystemFolder,
  type Tag,
} from "@/lib/mock-data";

import { Separator } from "./ui/separator";

// --- Helpers ---

function IconWithBadge({ children, show }: { children: React.ReactNode; show: boolean }) {
  return (
    <span className="relative">
      {children}
      {show && (
        <span className="absolute -top-1 -right-1 hidden size-2 rounded-full bg-destructive group-data-[collapsible=icon]:block" />
      )}
    </span>
  );
}

// --- Sidebar item components ---

function SystemFolderItem({
  folder,
  activeView,
  onViewChange,
  profileAccounts,
}: {
  folder: SystemFolder;
  activeView: string;
  onViewChange: (id: string) => void;
  profileAccounts: EmailAccount[];
}) {
  const Icon = folder.icon;
  const isMultiAccount = profileAccounts.length > 1;
  const hasChildren = isMultiAccount;
  const totalUnread = profileAccounts.reduce(
    (sum, acct) => sum + (folder.unreadByAccount[acct.id] ?? 0),
    0,
  );

  if (!hasChildren) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={folder.label}
          isActive={activeView === folder.id}
          onClick={() => onViewChange(folder.id)}
        >
          <IconWithBadge show={totalUnread > 0}>
            <Icon />
          </IconWithBadge>
          <span className={`truncate ${totalUnread > 0 ? "font-semibold" : ""}`}>
            {folder.label}
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
          tooltip={folder.label}
          isActive={activeView === folder.id}
          onClick={() => onViewChange(folder.id)}
        >
          <IconWithBadge show={totalUnread > 0}>
            <Icon />
          </IconWithBadge>
          <span className={`truncate ${totalUnread > 0 ? "font-semibold" : ""}`}>
            {folder.label}
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
                const acctUnread = folder.unreadByAccount[acct.id] ?? 0;
                return (
                  <SidebarMenuSubItem key={acct.id}>
                    <SidebarMenuSubButton
                      render={<button type="button" />}
                      tooltip={`${folder.label}/${getAccountDisplayName(acct)}`}
                      isActive={activeView === `${folder.id}:${acct.id}`}
                      onClick={() => onViewChange(`${folder.id}:${acct.id}`)}
                    >
                      <IconWithBadge show={acctUnread > 0}>
                        <Mailbox />
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

function FolderItem({
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

function AccountFolderItem({
  acctFolder,
  accounts,
  activeView,
  onViewChange,
}: {
  acctFolder: AccountFolders;
  accounts: EmailAccount[];
  activeView: string;
  onViewChange: (id: string) => void;
}) {
  const acct = accounts.find((a) => a.id === acctFolder.accountId);
  const displayName = acct ? getAccountDisplayName(acct) : acctFolder.accountId;

  return (
    <Collapsible defaultOpen>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip={displayName}>
          <Mailbox />
          <span className="truncate">{displayName}</span>
        </SidebarMenuButton>
        <CollapsibleTrigger render={<SidebarMenuAction />}>
          <ChevronRight className="transition-transform duration-200 in-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {[...acctFolder.folders]
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

function TagItem({
  tag,
  activeView,
  onViewChange,
}: {
  tag: Tag;
  activeView: string;
  onViewChange: (id: string) => void;
}) {
  const hasChildren = tag.children && tag.children.length > 0;

  if (!hasChildren) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={tag.label}
          isActive={activeView === `tag:${tag.id}`}
          onClick={() => onViewChange(`tag:${tag.id}`)}
        >
          <IconWithBadge show={tag.unread > 0}>
            <TagIcon style={{ color: tag.color }} />
          </IconWithBadge>
          <span className={`truncate ${tag.unread > 0 ? "font-semibold" : ""}`}>{tag.label}</span>
          {tag.unread > 0 && (
            <span className="shrink-0 text-xs text-sidebar-foreground/70 tabular-nums">
              {tag.unread}
            </span>
          )}
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  return (
    <Collapsible>
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={tag.label}
          isActive={activeView === `tag:${tag.id}`}
          onClick={() => onViewChange(`tag:${tag.id}`)}
        >
          <IconWithBadge show={tag.unread > 0}>
            <TagIcon style={{ color: tag.color }} />
          </IconWithBadge>
          <span className={`truncate ${tag.unread > 0 ? "font-semibold" : ""}`}>{tag.label}</span>
          {tag.unread > 0 && (
            <span className="shrink-0 text-xs text-sidebar-foreground/70 tabular-nums">
              {tag.unread}
            </span>
          )}
        </SidebarMenuButton>
        <CollapsibleTrigger render={<SidebarMenuAction />}>
          <ChevronRight className="transition-transform duration-200 in-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {[...tag.children!]
              .sort((a, b) => a.label.localeCompare(b.label))
              .map((child) => (
                <SidebarMenuSubItem key={child.id}>
                  <SidebarMenuSubButton
                    render={<button type="button" />}
                    tooltip={`${tag.label}/${child.label}`}
                    isActive={activeView === `tag:${child.id}`}
                    onClick={() => onViewChange(`tag:${child.id}`)}
                  >
                    <IconWithBadge show={child.unread > 0}>
                      <TagIcon style={{ color: child.color }} />
                    </IconWithBadge>
                    <span className={`truncate ${child.unread > 0 ? "font-semibold" : ""}`}>
                      {child.label}
                    </span>
                    {child.unread > 0 && (
                      <span className="shrink-0 text-xs text-sidebar-foreground/70 tabular-nums">
                        {child.unread}
                      </span>
                    )}
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

// --- Main sidebar ---

export function MailSidebar({
  activeView,
  onViewChange,
  activeProfileId,
  onProfileChange,
  session,
}: {
  activeView: string;
  onViewChange: (id: string) => void;
  activeProfileId: string;
  onProfileChange: (id: string) => void;
  session: { user: { name: string; email: string } };
}) {
  const navigate = useNavigate();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? profiles[0];
  const profileAccounts = accounts.filter((a) => activeProfile.accountIds.includes(a.id));
  const profileAccountFolders = accountFolders.filter((af) =>
    activeProfile.accountIds.includes(af.accountId),
  );

  const onSignOut = async () => {
    setIsSigningOut(true);
    await authClient.signOut();
    setIsSigningOut(false);
    await navigate({ to: "/sign-in" });
  };

  const userInitials = session.user.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <Sidebar collapsible="icon">
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

      <SidebarContent className="gap-0">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {systemFolders.map((folder) => (
                <SystemFolderItem
                  key={folder.id}
                  folder={folder}
                  activeView={activeView}
                  onViewChange={onViewChange}
                  profileAccounts={profileAccounts}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Folders</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {profileAccountFolders.map((acctFolder) => (
                <AccountFolderItem
                  key={acctFolder.accountId}
                  acctFolder={acctFolder}
                  accounts={accounts}
                  activeView={activeView}
                  onViewChange={onViewChange}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Tags</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {[...activeProfile.tags]
                .sort((a, b) => a.label.localeCompare(b.label))
                .map((tag) => (
                  <TagItem
                    key={tag.id}
                    tag={tag}
                    activeView={activeView}
                    onViewChange={onViewChange}
                  />
                ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <Popover>
        <PopoverTrigger
          render={
            <SidebarFooter className="h-(--footer-height) cursor-pointer border-t p-0 px-3 transition-colors group-data-[collapsible=icon]:pr-2 hover:bg-sidebar-accent" />
          }
        >
          <div className="flex h-full items-center gap-2 overflow-hidden">
            <Avatar className="size-8 shrink-0">
              <AvatarFallback className="text-xs">{userInitials}</AvatarFallback>
            </Avatar>
            <span className="truncate text-sm group-data-[collapsible=icon]:hidden">
              {session.user.name}
            </span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
              {activeProfile.name}
            </span>
          </div>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          alignOffset={8}
          className="w-60 gap-0 p-1.5"
        >
          <div className="px-2 pt-1.5 pb-0">
            <p className="text-xs text-muted-foreground">Signed in as</p>
            <p className="break-all">{session.user.email}</p>
          </div>
          <div className="grid grid-cols-2 gap-1.5 p-1.5">
            {profiles.map((profile) => {
              const ProfileIcon = profile.icon;
              const isActive = profile.id === activeProfileId;
              return (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => onProfileChange(profile.id)}
                  className={`flex min-w-0 cursor-pointer items-center gap-1.5 rounded-lg p-1.5 text-sm transition-colors ${
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  }`}
                >
                  <span
                    className="flex size-6 shrink-0 items-center justify-center rounded-full"
                    style={{ backgroundColor: profile.color }}
                  >
                    <ProfileIcon className="size-4 text-white" />
                  </span>
                  <span className="truncate">{profile.name}</span>
                </button>
              );
            })}
          </div>
          <Separator className="mx-1 my-1.5 w-auto!" />
          <Button
            variant="ghost"
            size="sm"
            className="flex cursor-pointer justify-start gap-2 font-normal"
          >
            <RefreshCw />
            Refresh emails
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="flex cursor-pointer justify-start gap-2 font-normal"
          >
            <Settings />
            Settings
          </Button>
          <Separator className="mx-1 my-1.5 w-auto!" />
          <Button
            variant="ghost"
            size="sm"
            className="flex cursor-pointer justify-start gap-2 font-normal"
            onClick={onSignOut}
            disabled={isSigningOut}
          >
            <LogOut />
            {isSigningOut ? "Signing out..." : "Sign out"}
          </Button>
        </PopoverContent>
      </Popover>
    </Sidebar>
  );
}
