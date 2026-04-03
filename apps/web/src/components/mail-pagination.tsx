import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Gmail-style pagination footer with first/prev/next/last buttons and a
 * "{rangeStart}-{rangeEnd} of {totalItems}" counter. Buttons disable at boundaries. */
export function MailPagination({
  page,
  totalPages,
  rangeStart,
  rangeEnd,
  totalItems,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  rangeStart: number;
  rangeEnd: number;
  totalItems: number;
  onPageChange: (page: number) => void;
}) {
  const isFirstPage = page === 1;
  const isLastPage = page === totalPages;

  return (
    <footer className="flex h-(--footer-height) shrink-0 items-center justify-center border-t px-3">
      <Button
        variant="ghost"
        size="icon-sm"
        className="cursor-pointer"
        disabled={isFirstPage}
        onClick={() => onPageChange(1)}
      >
        <ChevronFirst />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="cursor-pointer"
        disabled={isFirstPage}
        onClick={() => onPageChange(Math.max(1, page - 1))}
      >
        <ChevronLeft />
      </Button>
      <span className="px-3 text-xs text-muted-foreground">
        {rangeStart}-{rangeEnd} of {totalItems}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        className="cursor-pointer"
        disabled={isLastPage}
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
      >
        <ChevronRight />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="cursor-pointer"
        disabled={isLastPage}
        onClick={() => onPageChange(totalPages)}
      >
        <ChevronLast />
      </Button>
    </footer>
  );
}
