import { Link, useRouterState } from "@tanstack/react-router";
import { CalendarClock, Coins, FileText, GraduationCap, LayoutGrid, Users } from "lucide-react";
import type { CSSProperties, ElementType } from "react";
import { cn } from "@/lib/utils";
import {
  hasAdminPermission,
  useAdminPermissions,
  type AdminAction,
  type AdminDomain,
} from "@/lib/admin";

type SubNavItem = {
  to:
    | "/admin"
    | "/admin/users"
    | "/admin/sessions"
    | "/admin/finance"
    | "/admin/reports"
    | "/admin/skills";
  label: string;
  icon: ElementType;
  domain: AdminDomain;
  action: AdminAction;
};

const ITEMS: SubNavItem[] = [
  { to: "/admin", label: "Overview", icon: LayoutGrid, domain: "analytics", action: "read" },
  { to: "/admin/users", label: "Users", icon: Users, domain: "users", action: "read" },
  {
    to: "/admin/sessions",
    label: "Sessions",
    icon: CalendarClock,
    domain: "sessions",
    action: "read",
  },
  { to: "/admin/finance", label: "Finance", icon: Coins, domain: "wallet", action: "read" },
  {
    to: "/admin/reports",
    label: "Reports",
    icon: FileText,
    domain: "moderation",
    action: "read",
  },
  {
    to: "/admin/skills",
    label: "Skills",
    icon: GraduationCap,
    domain: "moderation",
    action: "update",
  },
];

export function AdminSubNav() {
  const permissionsQuery = useAdminPermissions();
  const permissions = permissionsQuery.data;
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  if (!permissions || permissions.length === 0) return null;

  const allowed = ITEMS.filter((item) => hasAdminPermission(permissions, item.domain, item.action));
  if (allowed.length === 0) return null;

  return (
    <nav className="mx-auto mb-4 w-full max-w-7xl px-4 pt-3 sm:px-6">
      <div
        className="grid auto-cols-[minmax(8rem,1fr)] grid-flow-col gap-1 overflow-x-auto rounded-full border border-border/70 bg-card/70 p-1.5 shadow-sm backdrop-blur md:auto-cols-auto md:grid-flow-row md:[grid-template-columns:repeat(var(--admin-tab-count),minmax(0,1fr))]"
        style={{ "--admin-tab-count": allowed.length } as CSSProperties}
      >
        {allowed.map((item) => {
          const active = pathname === item.to;
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "flex h-9 shrink-0 items-center justify-center gap-2 rounded-full px-3 text-sm font-medium transition-all",
                active
                  ? "bg-primary text-primary-foreground shadow-md shadow-primary/20"
                  : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
