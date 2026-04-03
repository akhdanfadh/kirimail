import {
  Archive,
  Bookmark,
  Clock,
  Mail,
  MailOpen,
  OctagonAlert,
  Square,
  SquareCheck,
  SquareCheckBig,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** Bulk action toolbar shown when selection mode is active. Displays selected
 * count and action buttons: read, unread, bookmark, snooze, archive, spam, delete.
 * Destructive actions (spam, delete) turn red on hover. */
export function MailSelection({
  selectedCount,
  totalCount,
  isAllSelected,
  onHeaderCheckbox,
}: {
  selectedCount: number;
  totalCount: number;
  isAllSelected: boolean;
  onHeaderCheckbox: () => void;
}) {
  return (
    <div className="-mt-1.5 flex shrink-0 items-center border-b px-3 pb-1.5 text-muted-foreground">
      <Button
        variant="ghost"
        size="icon-sm"
        className="mr-1 cursor-pointer md:hidden"
        aria-label={isAllSelected ? "Deselect all" : "Select all"}
        onClick={onHeaderCheckbox}
      >
        {isAllSelected ? <SquareCheckBig /> : selectedCount > 0 ? <SquareCheck /> : <Square />}
      </Button>
      <span className="mr-auto px-1.5 text-xs text-muted-foreground">
        {selectedCount}/{totalCount} selected
      </span>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>
            <Button variant="ghost" size="icon-sm" className="cursor-pointer">
              <MailOpen />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Mark as read</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>
            <Button variant="ghost" size="icon-sm" className="cursor-pointer">
              <Mail />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Mark as unread</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>
            <Button variant="ghost" size="icon-sm" className="cursor-pointer">
              <Bookmark />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Bookmark</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>
            <Button variant="ghost" size="icon-sm" className="cursor-pointer">
              <Clock />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Snooze</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>
            <Button variant="ghost" size="icon-sm" className="cursor-pointer">
              <Archive />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Archive</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>
            <Button
              variant="ghost"
              size="icon-sm"
              className="cursor-pointer hover:text-destructive"
            >
              <OctagonAlert />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Mark as spam</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>
            <Button
              variant="ghost"
              size="icon-sm"
              className="cursor-pointer hover:text-destructive"
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Delete</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
