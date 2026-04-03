import { Archive, Bookmark, Clock, Mail, MailOpen, Trash2 } from "lucide-react";

import type { MockEmail } from "@/lib/mock-data";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Single email row in the mail list. Shows avatar, bookmark, sender, timestamp,
 * subject, snippet with tags, and hover actions (read/unread, archive, snooze, delete).
 * Unread emails have a subtle background highlight. */
export function MailListItem({
  email,
  isBookmarked,
  isSelected,
  selectionMode,
  onToggleBookmark,
  onToggleSelect,
}: {
  email: MockEmail;
  isBookmarked: boolean;
  isSelected: boolean;
  selectionMode: boolean;
  onToggleBookmark: () => void;
  onToggleSelect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        "group flex w-full items-start gap-2 border-b px-3 py-2 text-left transition-colors select-none hover:bg-accent",
        !email.read && "bg-accent/50",
      )}
    >
      {/* Left column: avatar + selection checkbox (visible on hover or in selection mode) */}
      <div className="mt-0.5 flex shrink-0 flex-col items-center gap-2">
        <Avatar className="size-8">
          <AvatarFallback className="text-sm">{email.senderInitials}</AvatarFallback>
        </Avatar>
        <div
          className={cn("h-4", selectionMode ? "visible" : "md:invisible md:group-hover:visible")}
        >
          <Checkbox
            aria-label={`Select ${email.senderName}`}
            className="cursor-pointer"
            checked={isSelected}
            onCheckedChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      </div>
      {/* Right column: sender row, subject, snippet + tags */}
      <TooltipProvider>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Row 1: bookmark + sender name | timestamp (or hover actions) */}
          <div className="flex h-5 items-center justify-between gap-1">
            <div className="flex min-w-0 items-center gap-1">
              <Tooltip>
                <TooltipTrigger>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleBookmark();
                    }}
                    className="shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-yellow-500"
                  >
                    <Bookmark
                      className={`size-3.5 ${isBookmarked ? "fill-yellow-500 text-yellow-500" : ""}`}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {isBookmarked ? "Remove bookmark" : "Bookmark"}
                </TooltipContent>
              </Tooltip>
              <span className={`truncate text-sm ${email.read ? "" : "font-semibold"}`}>
                {email.senderName}
              </span>
            </div>
            {/* Timestamp: visible by default, hidden on hover */}
            <span className="shrink-0 text-xs text-muted-foreground group-hover:hidden">
              {email.timestamp}
            </span>
            {/* Quick actions: hidden by default, shown on hover (replaces timestamp) */}
            <div className="hidden shrink-0 items-center text-muted-foreground group-hover:flex">
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="cursor-pointer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {email.read ? <Mail className="size-3.5" /> : <MailOpen className="size-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {email.read ? "Mark as unread" : "Mark as read"}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="cursor-pointer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Archive className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Archive</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="cursor-pointer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Clock className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Snooze</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="cursor-pointer hover:text-destructive"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Delete</TooltipContent>
              </Tooltip>
            </div>
          </div>
          {/* Row 2: subject */}
          <p className={`truncate text-sm ${email.read ? "" : "font-semibold"}`}>{email.subject}</p>
          {/* Row 3: snippet + tag badges (max 3 shown, overflow as "+N") */}
          <div className="flex items-center gap-1 overflow-hidden">
            <p className="truncate text-sm text-muted-foreground">{email.snippet}</p>
            {email.tags?.slice(0, 3).map((tag) => (
              <span
                key={tag.label}
                className="max-w-32 shrink-0 truncate rounded px-1.5 py-0.5 text-[10px]"
                style={{ backgroundColor: `${tag.color}30`, color: tag.color }}
              >
                {tag.label}
              </span>
            ))}
            {email.tags && email.tags.length > 3 && (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                +{email.tags.length - 3}
              </span>
            )}
          </div>
        </div>
      </TooltipProvider>
    </div>
  );
}
