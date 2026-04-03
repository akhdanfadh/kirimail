import { ChevronRight, Tag as TagIcon } from "lucide-react";

import type { Tag } from "@/lib/mock-data";

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

/** A single tag row. Tags with children become collapsible with alphabetically
 * sorted nested sub-tags. Tag color is applied to the icon. */
export function TagItem({
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
