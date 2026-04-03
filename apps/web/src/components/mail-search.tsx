import {
  ALargeSmall,
  AlignLeft,
  AtSign,
  BookmarkIcon,
  CalendarArrowDownIcon,
  CalendarArrowUpIcon,
  Folders,
  MailIcon,
  MailOpenIcon,
  PaperclipIcon,
  Tags,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { profiles } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

const folders = ["Inbox", "Sent", "Drafts", "Archive", "Spam", "Trash"];
const tags = profiles.flatMap((p) =>
  p.tags.flatMap((t) => [t.label, ...(t.children?.map((c) => c.label) ?? [])]),
);

/** Advanced search panel for the mail list. Manages its own form state internally
 * and reports active state to the parent via `onActiveChange`. */
export function MailSearch({
  className,
  onActiveChange,
  onSearch,
  clearTrigger,
}: {
  className?: string;
  onSearch?: () => void;
  onActiveChange?: (active: boolean) => void;
  clearTrigger?: number;
}) {
  // --- Quick search toggles (attachments, bookmarked, read/unread) ---
  const [quickSearches, setQuickSearches] = useState<Set<string>>(new Set());
  // Tri-state cycle: null → "unread" → "read" → null
  const [readSearch, setReadSearch] = useState<"unread" | "read" | null>(null);

  // --- Text search fields ---
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  // --- Multi-select comboboxes ---
  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  // --- Date range pickers ---
  const [afterDate, setAfterDate] = useState<Date | undefined>(undefined);
  const [beforeDate, setBeforeDate] = useState<Date | undefined>(undefined);
  const [afterOpen, setAfterOpen] = useState(false);
  const [beforeOpen, setBeforeOpen] = useState(false);
  // Combobox positioning anchors
  const folderAnchor = useComboboxAnchor();
  const tagAnchor = useComboboxAnchor();

  // --- Handlers ---

  const toggleQuickSearch = (key: string) => {
    setQuickSearches((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const cycleReadSearch = () => {
    setReadSearch((prev) => (prev === null ? "unread" : prev === "unread" ? "read" : null));
  };

  // Parent can trigger clear by incrementing clearTrigger
  useEffect(() => {
    if (clearTrigger && clearTrigger > 0) clearSearch();
  }, [clearTrigger]);

  const clearSearch = () => {
    setQuickSearches(new Set());
    setReadSearch(null);
    setFrom("");
    setTo("");
    setSubject("");
    setBody("");
    setSelectedFolders([]);
    setSelectedTags([]);
    setAfterDate(undefined);
    setBeforeDate(undefined);
  };

  // --- Derived state: report to parent whether any field has a value ---

  const hasActiveSearch =
    quickSearches.size > 0 ||
    readSearch !== null ||
    !!from ||
    !!to ||
    !!subject ||
    !!body ||
    selectedFolders.length > 0 ||
    selectedTags.length > 0 ||
    !!afterDate ||
    !!beforeDate;

  useEffect(() => {
    onActiveChange?.(hasActiveSearch);
  }, [hasActiveSearch, onActiveChange]);

  // --- Styling helpers ---

  /** Applied to fields that have a value, matching the focus ring style */
  const activeBorder = "border-ring! ring-2 ring-ring/50";

  /** Enter in any text field triggers the parent's search action */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") onSearch?.();
  };

  // --- Render ---

  return (
    <div className={cn("shrink-0 space-y-1 p-3", className)}>
      {/* Quick search toggles: Attachments, Bookmarked, Read/Unread */}
      <div className="flex flex-wrap items-center justify-center-safe gap-1">
        <Button
          variant={readSearch ? "secondary" : "outline"}
          size="xs"
          className={cn(
            "rounded-full font-normal",
            readSearch ? activeBorder : "text-muted-foreground",
          )}
          onClick={cycleReadSearch}
        >
          {readSearch === "read" ? (
            <MailOpenIcon data-icon="inline-start" />
          ) : (
            <MailIcon data-icon="inline-start" />
          )}
          {readSearch === "read" ? "Read" : "Unread"}
        </Button>
        <Button
          variant={quickSearches.has("bookmarked") ? "secondary" : "outline"}
          size="xs"
          className={cn(
            "rounded-full font-normal",
            quickSearches.has("bookmarked") ? activeBorder : "text-muted-foreground",
          )}
          onClick={() => toggleQuickSearch("bookmarked")}
        >
          <BookmarkIcon data-icon="inline-start" /> Bookmarked
        </Button>
        <Button
          variant={quickSearches.has("attachments") ? "secondary" : "outline"}
          size="xs"
          className={cn(
            "rounded-full font-normal",
            quickSearches.has("attachments") ? activeBorder : "text-muted-foreground",
          )}
          onClick={() => toggleQuickSearch("attachments")}
        >
          <PaperclipIcon data-icon="inline-start" /> Attachments
        </Button>
      </div>

      {/* Text fields: From/To, Subject, Body */}
      <div className="space-y-1">
        <InputGroup className={cn("h-8", from && activeBorder)}>
          <InputGroupAddon className={from ? "text-foreground" : ""}>
            <UserRound />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="From..."
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </InputGroup>
        <InputGroup className={cn("h-8", to && activeBorder)}>
          <InputGroupAddon className={to ? "text-foreground" : ""}>
            <AtSign />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="To..."
            value={to}
            onChange={(e) => setTo(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </InputGroup>
        <InputGroup className={cn("h-8", subject && activeBorder)}>
          <InputGroupAddon className={subject ? "text-foreground" : ""}>
            <ALargeSmall />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Subject contains..."
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </InputGroup>
        <InputGroup className={cn("h-8", body && activeBorder)}>
          <InputGroupAddon className={body ? "text-foreground" : ""}>
            <AlignLeft />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Body contains..."
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </InputGroup>

        {/* Date range: After / Before (popover calendars with dropdown navigation) */}
        <div className="grid grid-cols-2 gap-1">
          <Popover open={afterOpen} onOpenChange={setAfterOpen}>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  className={cn(
                    "h-8 justify-start gap-2 font-normal",
                    afterDate ? activeBorder : "text-muted-foreground",
                  )}
                />
              }
            >
              <CalendarArrowUpIcon className="size-4" />
              {afterDate ? afterDate.toLocaleDateString() : "After..."}
            </PopoverTrigger>
            <PopoverContent className="w-auto overflow-hidden p-0" align="start">
              <Calendar
                mode="single"
                selected={afterDate}
                defaultMonth={afterDate}
                className="rounded-lg border"
                captionLayout="dropdown"
                onSelect={(date) => {
                  setAfterDate(date);
                  setAfterOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
          <Popover open={beforeOpen} onOpenChange={setBeforeOpen}>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  className={cn(
                    "h-8 justify-start gap-2 font-normal",
                    beforeDate ? activeBorder : "text-muted-foreground",
                  )}
                />
              }
            >
              <CalendarArrowDownIcon className="size-4" />
              {beforeDate ? beforeDate.toLocaleDateString() : "Before..."}
            </PopoverTrigger>
            <PopoverContent className="w-auto overflow-hidden p-0" align="end">
              <Calendar
                mode="single"
                selected={beforeDate}
                defaultMonth={beforeDate}
                className="rounded-lg border"
                captionLayout="dropdown"
                onSelect={(date) => {
                  setBeforeDate(date);
                  setBeforeOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
        </div>

        {/* Multi-select comboboxes: Folders, Tags */}
        <Combobox
          multiple
          autoHighlight
          items={folders}
          value={selectedFolders}
          onValueChange={setSelectedFolders}
        >
          <div className="relative">
            <Folders
              className={cn(
                "pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2",
                selectedFolders.length > 0 ? "text-foreground" : "text-muted-foreground",
              )}
            />
            <ComboboxChips
              ref={folderAnchor}
              className={cn("min-h-8 py-1 pl-8!", selectedFolders.length > 0 && activeBorder)}
            >
              <ComboboxValue>
                {selectedFolders.map((folder) => (
                  <ComboboxChip key={folder}>{folder}</ComboboxChip>
                ))}
              </ComboboxValue>
              <ComboboxChipsInput
                placeholder={selectedFolders.length === 0 ? "Select folders..." : ""}
              />
            </ComboboxChips>
          </div>
          <ComboboxContent anchor={folderAnchor}>
            <ComboboxEmpty>No folders found.</ComboboxEmpty>
            <ComboboxList>
              {(item) => (
                <ComboboxItem key={item} value={item}>
                  {item}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        <Combobox
          multiple
          autoHighlight
          items={tags}
          value={selectedTags}
          onValueChange={setSelectedTags}
        >
          <div className="relative">
            <Tags
              className={cn(
                "pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2",
                selectedTags.length > 0 ? "text-foreground" : "text-muted-foreground",
              )}
            />
            <ComboboxChips
              ref={tagAnchor}
              className={cn("min-h-8 py-1 pl-8!", selectedTags.length > 0 && activeBorder)}
            >
              <ComboboxValue>
                {selectedTags.map((tag) => (
                  <ComboboxChip key={tag}>{tag}</ComboboxChip>
                ))}
              </ComboboxValue>
              <ComboboxChipsInput placeholder={selectedTags.length === 0 ? "Select tags..." : ""} />
            </ComboboxChips>
          </div>
          <ComboboxContent anchor={tagAnchor}>
            <ComboboxEmpty>No tags found.</ComboboxEmpty>
            <ComboboxList>
              {(item) => (
                <ComboboxItem key={item} value={item}>
                  {item}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </div>
    </div>
  );
}
