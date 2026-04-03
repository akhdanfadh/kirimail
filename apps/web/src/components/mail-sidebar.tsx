import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";
import { accounts, accountFolders, mailboxes, profiles } from "@/lib/mock-data";

import { FolderTree } from "./sidebar/folder-tree";
import { MailSidebarFooter } from "./sidebar/footer";
import { MailSidebarHeader } from "./sidebar/header";
import { MailboxItem } from "./sidebar/mailbox";
import { TagItem } from "./sidebar/tag";

/** Orchestrator for the mail sidebar. Manages profile/view state and delegates
 * rendering to sub-components in the `sidebar/` directory. */
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
  const profileFolders = accountFolders.filter((af) =>
    activeProfile.accountIds.includes(af.accountId),
  );

  const onSignOut = async () => {
    setIsSigningOut(true);
    await authClient.signOut();
    setIsSigningOut(false);
    await navigate({ to: "/sign-in" });
  };

  return (
    <Sidebar collapsible="icon">
      <MailSidebarHeader profileAccounts={profileAccounts} />

      <SidebarContent className="gap-0">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {mailboxes.map((mailbox) => (
                <MailboxItem
                  key={mailbox.id}
                  mailbox={mailbox}
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
              {profileFolders.map((af) => (
                <FolderTree
                  key={af.accountId}
                  accountFolders={af}
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

      <MailSidebarFooter
        session={session}
        activeProfileId={activeProfileId}
        onProfileChange={onProfileChange}
        onSignOut={onSignOut}
        isSigningOut={isSigningOut}
      />
    </Sidebar>
  );
}
