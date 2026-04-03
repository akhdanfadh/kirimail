/** Wraps an icon with an optional unread dot. The dot is hidden by default and
 * only visible in collapsed-icon mode, where it replaces text-based unread counts. */
export function IconWithBadge({ children, show }: { children: React.ReactNode; show: boolean }) {
  return (
    <span className="relative">
      {children}
      {/* Hidden by default; shown only when sidebar is collapsed to icons via group-data selector */}
      {show && (
        <span className="absolute -top-1 -right-1 hidden size-2 rounded-full bg-destructive group-data-[collapsible=icon]:block" />
      )}
    </span>
  );
}
