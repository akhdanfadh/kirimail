import type { LucideIcon } from "lucide-react";

import {
  Archive,
  Briefcase,
  ChartNoAxesGantt,
  ClipboardClock,
  Clock,
  House,
  Inbox,
  NotepadTextDashed,
  OctagonX,
  Pyramid,
  Receipt,
  Rss,
  Send,
  Trash2,
} from "lucide-react";

// --- Types ---

export type EmailAccount = {
  id: string;
  email: string;
  alias?: string;
};

export type Mailbox = {
  id: string;
  role: string;
  label: string;
  icon: LucideIcon;
  /** Per-account unread counts. Key is account ID. */
  unreadByAccount: Record<string, number>;
};

export type Folder = {
  id: string;
  label: string;
  icon?: LucideIcon;
  unread: number;
  children?: Folder[];
};

export type AccountFolders = {
  accountId: string;
  folders: Folder[];
};

export type Tag = {
  id: string;
  label: string;
  color: string;
  unread: number;
  children?: Tag[];
};

export type MockEmail = {
  id: string;
  senderName: string;
  senderInitials: string;
  timestamp: string;
  subject: string;
  snippet: string;
  bookmarked: boolean;
  read: boolean;
  tags?: { label: string; color: string }[];
};

export type Profile = {
  id: string;
  name: string;
  icon: LucideIcon;
  color: string;
  accountIds: string[];
  tags: Tag[];
};

// --- Mock accounts ---

export const accounts: EmailAccount[] = [
  { id: "acct-1", email: "jane@personal.com" },
  { id: "acct-2", email: "senior.infrastructure.engineer@longcompanyname.com", alias: "company1" },
  { id: "acct-3", email: "lead.visual.designer@anotherverylongcompany.co.jp" },
  { id: "acct-4", email: "jane@sideproject.dev" },
];

/** Display name for an account: alias if set, otherwise full email. */
export function getAccountDisplayName(account: EmailAccount): string {
  return account.alias ?? account.email;
}

// --- Mailboxes (role-based, unified across accounts) ---

export const mailboxes: Mailbox[] = [
  {
    id: "inbox",
    role: "inbox",
    label: "Inbox",
    icon: Inbox,
    unreadByAccount: { "acct-1": 3, "acct-2": 5, "acct-3": 2, "acct-4": 1 },
  },
  {
    id: "snoozed",
    role: "snoozed",
    label: "Snoozed",
    icon: Clock,
    unreadByAccount: { "acct-1": 1 },
  },
  {
    id: "drafts",
    role: "drafts",
    label: "Drafts",
    icon: NotepadTextDashed,
    unreadByAccount: { "acct-1": 1, "acct-2": 0, "acct-3": 0 },
  },
  {
    id: "scheduled",
    role: "scheduled",
    label: "Scheduled",
    icon: ClipboardClock,
    unreadByAccount: { "acct-1": 2 },
  },
  {
    id: "sent",
    role: "sent",
    label: "Sent",
    icon: Send,
    unreadByAccount: {},
  },
  {
    id: "archive",
    role: "archive",
    label: "Archive",
    icon: Archive,
    unreadByAccount: {},
  },
  {
    id: "junk",
    role: "spam",
    label: "Junk/Spam",
    icon: OctagonX,
    unreadByAccount: {},
  },
  {
    id: "trash",
    role: "trash",
    label: "Trash",
    icon: Trash2,
    unreadByAccount: {},
  },
];

// --- Per-account native folders ---

export const accountFolders: AccountFolders[] = [
  {
    accountId: "acct-1",
    folders: [
      {
        id: "cf-1",
        label: "Newsletters",
        icon: Rss,
        unread: 0,
        children: [
          { id: "cf-1-1", label: "Tech", unread: 2 },
          { id: "cf-1-2", label: "Design", unread: 1 },
        ],
      },
      { id: "cf-2", label: "Receipts & Purchase Confirmations", icon: Receipt, unread: 0 },
    ],
  },
  {
    accountId: "acct-2",
    folders: [
      {
        id: "cf-3",
        label: "Projects",
        icon: ChartNoAxesGantt,
        unread: 4,
        children: [
          { id: "cf-3-1", label: "Project Alpha", unread: 0 },
          { id: "cf-3-2", label: "Project Beta", unread: 0 },
        ],
      },
    ],
  },
  {
    accountId: "acct-3",
    folders: [{ id: "cf-4", label: "Clients", icon: Pyramid, unread: 0 }],
  },
  {
    accountId: "acct-4",
    folders: [{ id: "cf-5", label: "Beta Testers", unread: 1 }],
  },
];

// --- Profiles ---

export const profiles: Profile[] = [
  {
    id: "profile-1",
    name: "Personal",
    icon: House,
    color: "#3b82f6",
    accountIds: ["acct-1"],
    tags: [
      { id: "tag-1", label: "Important", color: "#ef4444", unread: 2 },
      {
        id: "tag-2",
        label: "Finance",
        color: "#22c55e",
        unread: 0,
        children: [
          { id: "tag-2-1", label: "Invoices", color: "#22c55e", unread: 1 },
          { id: "tag-2-2", label: "Taxes", color: "#22c55e", unread: 0 },
        ],
      },
      { id: "tag-3", label: "Travel", color: "#3b82f6", unread: 0 },
      { id: "tag-6", label: "Shopping", color: "#ec4899", unread: 3 },
      { id: "tag-7", label: "Health", color: "#14b8a6", unread: 0 },
      { id: "tag-8", label: "Subscriptions", color: "#8b5cf6", unread: 1 },
      { id: "tag-9", label: "Family", color: "#f59e0b", unread: 0 },
      { id: "tag-10", label: "Insurance", color: "#06b6d4", unread: 0 },
      { id: "tag-11", label: "Education", color: "#84cc16", unread: 2 },
      { id: "tag-12", label: "Hobbies", color: "#f97316", unread: 0 },
      { id: "tag-13", label: "Utilities", color: "#64748b", unread: 1 },
      { id: "tag-14", label: "Social", color: "#e879f9", unread: 0 },
      { id: "tag-15", label: "Donations", color: "#fb923c", unread: 0 },
    ],
  },
  {
    id: "profile-2",
    name: "Work",
    icon: Briefcase,
    color: "#ef4444",
    accountIds: ["acct-2", "acct-3"],
    tags: [
      { id: "tag-4", label: "Urgent", color: "#f97316", unread: 4 },
      { id: "tag-5", label: "Code Reviews & Design Feedback", color: "#a855f7", unread: 1 },
    ],
  },
  {
    id: "profile-3",
    name: "Side Project",
    icon: Pyramid,
    color: "#8b5cf6",
    accountIds: ["acct-4"],
    tags: [
      { id: "tag-16", label: "Ideas", color: "#6366f1", unread: 0 },
      { id: "tag-17", label: "Feedback", color: "#f43f5e", unread: 1 },
    ],
  },
];

// --- Mock emails ---

export const mockEmails: MockEmail[] = [
  {
    id: "e1",
    senderName: "Google",
    senderInitials: "G",
    timestamp: "19:21",
    subject: "Security Alert",
    snippet:
      "A new sign-in on your account was detected from a Windows device in Jakarta, Indonesia.",
    bookmarked: false,
    read: false,
    tags: [{ label: "Important", color: "#ef4444" }],
  },
  {
    id: "e2",
    senderName: "OpenAI",
    senderInitials: "OA",
    timestamp: "Apr 1",
    subject: "OpenAI Dev News: GPT-5.9, Plugins in Production, and the Agents SDK",
    snippet:
      "See what the latest models can really do — plus a deep dive into the new function-calling improvements and structured outputs.",
    bookmarked: true,
    read: false,
    tags: [{ label: "Education", color: "#84cc16" }],
  },
  {
    id: "e3",
    senderName: "GitHub",
    senderInitials: "GH",
    timestamp: "Mar 31",
    subject: "Your pull request was merged",
    snippet:
      "Pull request #42 has been merged into main by akhdanfadh. 3 files changed, 47 insertions, 12 deletions.",
    bookmarked: false,
    read: true,
  },
  {
    id: "e4",
    senderName: "Stripe",
    senderInitials: "S",
    timestamp: "Mar 31",
    subject: "Your March invoice is ready",
    snippet:
      "Invoice #INV-2026-0331 for $49.00 is available. Payment will be automatically charged to your Visa ending in 4242.",
    bookmarked: false,
    read: true,
    tags: [
      { label: "Finance", color: "#22c55e" },
      { label: "Invoices", color: "#22c55e" },
    ],
  },
  {
    id: "e5",
    senderName: "Linear",
    senderInitials: "L",
    timestamp: "Mar 30",
    subject: "5 issues assigned to you",
    snippet:
      "You have new issues in Project Alpha that need attention: KM-128 auth flow, KM-129 sidebar, KM-130 mail list, and 2 more.",
    bookmarked: false,
    read: true,
    tags: [{ label: "Urgent", color: "#f97316" }],
  },
  {
    id: "e6",
    senderName: "Alice Johnson-Whitfield",
    senderInitials: "AJ",
    timestamp: "Mar 30",
    subject:
      "Re: Q2 Planning — Updated timeline and resource allocation for the infrastructure migration",
    snippet:
      "Sounds good! Let's sync on Thursday afternoon. I've updated the shared doc with the revised estimates and added notes from the stakeholder review.",
    bookmarked: true,
    read: true,
    tags: [
      { label: "Q2 Infrastructure Migration Planning & Resource Allocation", color: "#3b82f6" },
    ],
  },
  {
    id: "e7",
    senderName: "Vercel",
    senderInitials: "V",
    timestamp: "Mar 29",
    subject: "Deployment successful",
    snippet:
      "Your project kirimail-web was deployed to production. Build completed in 34s with no errors or warnings.",
    bookmarked: false,
    read: true,
  },
  {
    id: "e8",
    senderName: "Bob Smith",
    senderInitials: "BS",
    timestamp: "Mar 29",
    subject: "Design Review Feedback",
    snippet:
      "I've left some comments on the Figma file for the mail list component. Main concern is the spacing between list items on mobile viewports.",
    bookmarked: false,
    read: true,
    tags: [{ label: "Code Reviews & Design Feedback", color: "#a855f7" }],
  },
  {
    id: "e9",
    senderName: "Hetzner",
    senderInitials: "H",
    timestamp: "Mar 28",
    subject: "Scheduled maintenance for your dedicated server cx41-Helsinki-dc2",
    snippet:
      "Scheduled maintenance window for your server on April 5, 2026 between 02:00–04:00 UTC. Expect up to 15 minutes of downtime.",
    bookmarked: false,
    read: true,
    tags: [
      { label: "Important", color: "#ef4444" },
      { label: "Utilities", color: "#64748b" },
      { label: "Insurance", color: "#06b6d4" },
      { label: "Finance", color: "#22c55e" },
      { label: "Subscriptions", color: "#8b5cf6" },
    ],
  },
  {
    id: "e10",
    senderName: "The Pragmatic Engineer Newsletter by Gergely Orosz",
    senderInitials: "PE",
    timestamp: "Mar 28",
    subject: "This week in tech: Why every startup is building their own email client now",
    snippet:
      "Top stories this week: AI-powered developer tools raise $2B in Q1, the return of server-rendered apps, and why email clients are the new to-do apps.",
    bookmarked: false,
    read: true,
  },
];
