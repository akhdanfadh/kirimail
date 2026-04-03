import { Eraser, ListFilter, SearchIcon, Square, SquareCheck, SquareCheckBig } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { mockEmails } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

import { MailListItem } from "./list/item";
import { MailPagination } from "./list/pagination";
import { MailSearch } from "./list/search";
import { MailSelection } from "./list/selection";

/** Orchestrator for the mail list panel. Manages search, selection, bookmark,
 * and pagination state, then composes MailSearch, MailSelection, MailListItem,
 * and MailPagination. */
export function MailList() {
  // --- State ---
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(
    () => new Set(mockEmails.filter((e) => e.bookmarked).map((e) => e.id)),
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [hasAdvancedSearch, setHasAdvancedSearch] = useState(false);
  const [clearTrigger, setClearTrigger] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const headerRef = useRef<HTMLElement>(null);

  // --- Pagination derived values ---
  const pageSize = mockEmails.length;
  const totalItems = 111; // mock total
  const totalPages = Math.ceil(totalItems / pageSize);
  const rangeStart = (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, totalItems);

  // --- Search handlers ---

  // TODO: execute search with searchQuery + advanced search values
  const handleSearch = () => {
    console.log("search triggered:", searchQuery);
  };

  const handleClear = () => {
    setSearchQuery("");
    setHasAdvancedSearch(false);
    setClearTrigger((n) => n + 1);
  };

  const hasActiveSearch = !!searchQuery || hasAdvancedSearch;

  // Tri-state cycle: [ ] unchecked → [-] selection mode → [✓] select all → [ ]
  const allIds = mockEmails.map((e) => e.id);
  const isAllSelected = selectionMode && selectedIds.size === allIds.length;
  const handleHeaderCheckbox = () => {
    if (!selectionMode) {
      setSelectionMode(true);
      setSelectedIds(new Set());
    } else if (!isAllSelected) {
      setSelectedIds(new Set(allIds));
    } else {
      setSelectionMode(false);
      setSelectedIds(new Set());
    }
  };

  // --- Selection + bookmark handlers ---

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    if (next.size === 0) {
      setSelectionMode(false);
    } else if (!selectionMode) {
      setSelectionMode(true);
    }
    setSelectedIds(next);
  };

  const toggleBookmark = (id: string) => {
    setBookmarkedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        ref={headerRef}
        className={cn(
          "flex h-(--header-height) shrink-0 items-center gap-2 border-b px-3",
          selectionMode && "border-transparent",
        )}
      >
        <SidebarTrigger
          className="cursor-pointer text-muted-foreground md:hidden"
          variant="outline"
        />
        <Button
          variant="outline"
          size="icon-sm"
          className={cn("hidden cursor-pointer md:flex", !selectionMode && "text-muted-foreground")}
          aria-label={
            !selectionMode ? "Enter selection mode" : isAllSelected ? "Deselect all" : "Select all"
          }
          onClick={handleHeaderCheckbox}
        >
          {isAllSelected ? <SquareCheckBig /> : selectionMode ? <SquareCheck /> : <Square />}
        </Button>
        <Popover open={searchOpen} onOpenChange={setSearchOpen}>
          <ButtonGroup className="flex-1">
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  className={cn(
                    "relative cursor-pointer",
                    searchOpen || hasAdvancedSearch ? "text-foreground" : "text-muted-foreground",
                  )}
                  aria-label="Advanced search"
                />
              }
            >
              <ListFilter />
              {hasAdvancedSearch && (
                <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-destructive" />
              )}
            </PopoverTrigger>
            <InputGroup className="h-8">
              <InputGroupInput
                placeholder="Search mail..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSearch();
                }}
              />
              {hasActiveSearch && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={handleClear}
                    aria-label="Clear search"
                  >
                    <Eraser />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Search"
              onClick={handleSearch}
              className="cursor-pointer text-muted-foreground hover:text-foreground"
            >
              <SearchIcon />
            </Button>
          </ButtonGroup>
          <PopoverContent
            keepMounted
            anchor={headerRef}
            side="bottom"
            align="center"
            sideOffset={-8}
            className="w-[calc(var(--anchor-width)-1.5rem)] p-0"
          >
            <MailSearch
              onActiveChange={setHasAdvancedSearch}
              onSearch={handleSearch}
              clearTrigger={clearTrigger}
            />
          </PopoverContent>
        </Popover>
      </header>

      {selectionMode && (
        <MailSelection
          selectedCount={selectedIds.size}
          totalCount={mockEmails.length}
          isAllSelected={isAllSelected}
          onHeaderCheckbox={handleHeaderCheckbox}
        />
      )}

      <div className="flex-1 overflow-y-auto">
        {mockEmails.map((email) => (
          <MailListItem
            key={email.id}
            email={email}
            isBookmarked={bookmarkedIds.has(email.id)}
            isSelected={selectedIds.has(email.id)}
            selectionMode={selectionMode}
            onToggleBookmark={() => toggleBookmark(email.id)}
            onToggleSelect={() => toggleSelect(email.id)}
          />
        ))}
      </div>

      <MailPagination
        page={page}
        totalPages={totalPages}
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        totalItems={totalItems}
        onPageChange={setPage}
      />
    </div>
  );
}
