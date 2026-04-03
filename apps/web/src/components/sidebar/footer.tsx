import { LogOut, RefreshCw, Settings } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { SidebarFooter } from "@/components/ui/sidebar";
import { profiles } from "@/lib/mock-data";

/** Sidebar footer with user avatar, profile switcher popover, and sign-out.
 * The popover shows profile switching grid, refresh, settings, and sign out. */
export function MailSidebarFooter({
  session,
  activeProfileId,
  onProfileChange,
  onSignOut,
  isSigningOut,
}: {
  session: { user: { name: string; email: string } };
  activeProfileId: string;
  onProfileChange: (id: string) => void;
  onSignOut: () => void;
  isSigningOut: boolean;
}) {
  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? profiles[0];

  const userInitials = session.user.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <Popover>
      {/* SidebarFooter itself is the popover trigger — the entire footer area is clickable */}
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
  );
}
