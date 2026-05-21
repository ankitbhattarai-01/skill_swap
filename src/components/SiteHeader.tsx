import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Suspense, lazy, memo, useEffect, useState } from "react";
import type { CSSProperties, ElementType } from "react";
import { Button } from "@/components/ui/button";
import { Logo } from "./Logo";
import { UserAvatar } from "./UserAvatar";

const GlobalSearch = lazy(() =>
  import("./GlobalSearch").then((m) => ({ default: m.GlobalSearch })),
);
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { signSingleAvatarUrl } from "@/lib/avatars";
import { PROFILE_UPDATED_EVENT } from "@/lib/profile-events";
import { useMyCreditBalance } from "@/hooks/useMyCreditBalance";
import { NotificationsMenu } from "./NotificationsMenu";
import { StrikeIndicator } from "./StrikeIndicator";
import { ThemeToggle } from "./ThemeToggle";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Coins,
  History,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  ShieldCheck,
  User as UserIcon,
  UserRoundSearch,
  Video,
} from "lucide-react";

type NavItem = { name: string; icon: ElementType; to: string };
type HeaderProfile = {
  full_name: string | null;
  avatar_url: string | null;
  is_admin?: boolean;
};

type SiteHeaderProps = {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
};

const HEADER_PROFILE_CACHE_PREFIX = "skillswap-header-profile-";

const NAV_ITEMS: NavItem[] = [
  { name: "Home", icon: LayoutDashboard, to: "/dashboard" },
  { name: "Explore", icon: UserRoundSearch, to: "/explore" },
  { name: "Sessions", icon: Video, to: "/history" },
  { name: "Tracks", icon: BookOpen, to: "/tracks" },
  { name: "Credits", icon: Coins, to: "/credits" },
  { name: "Messages", icon: MessageSquare, to: "/messages" },
  { name: "Profile", icon: UserIcon, to: "/profile" },
];

function isItemActive(item: NavItem, pathname: string, authed: boolean): boolean {
  if (item.name === "Messages")
    return pathname === "/messages" || pathname.startsWith("/messages/");
  if (item.name === "Home") return pathname === (authed ? "/dashboard" : "/");
  return pathname === item.to || pathname.startsWith(item.to + "/");
}

function SidebarItem({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  return (
    <Link
      to={item.to}
      preload="intent"
      className={cn(
        "relative mx-auto flex h-12 items-center gap-3 rounded-2xl px-4 text-sm font-semibold transition-all duration-200",
        active
          ? "bg-primary text-primary-foreground glow-primary"
          : "text-muted-foreground hover:bg-secondary/80 hover:text-foreground",
        collapsed ? "w-12 justify-center px-0" : "w-[168px]",
      )}
      aria-current={active ? "page" : undefined}
    >
      <item.icon className="h-5 w-5 shrink-0" />
      {!collapsed && <span className="truncate">{item.name}</span>}
    </Link>
  );
}

function MobileNavItem({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      to={item.to}
      preload="intent"
      className={cn(
        "flex min-w-[64px] flex-col items-center gap-1 rounded-2xl px-3 py-2 text-xs font-semibold transition-colors",
        active ? "text-primary" : "text-muted-foreground",
      )}
      aria-current={active ? "page" : undefined}
    >
      <span className={cn("relative rounded-xl p-1.5", active && "bg-primary/10")}>
        <item.icon className="h-5 w-5" />
      </span>
      <span>{item.name}</span>
    </Link>
  );
}

function SiteHeaderInner({ sidebarCollapsed, onToggleSidebar }: SiteHeaderProps) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [profile, setProfile] = useState<HeaderProfile | null>(null);
  const { data: creditBalance } = useMyCreditBalance();

  useEffect(() => {
    if (!user) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    const cacheKey = `${HEADER_PROFILE_CACHE_PREFIX}${user.id}`;
    try {
      const cached = window.sessionStorage.getItem(cacheKey);
      if (cached) setProfile(JSON.parse(cached) as HeaderProfile);
    } catch {
      // Header cache is optional.
    }

    const loadProfile = async () => {
      try {
        // is_admin is no longer column-readable from public profile SELECTs
        // (it's hidden so admin accounts can't be enumerated). Credit
        // balance now flows through useMyCreditBalance (TanStack Query),
        // so only name/avatar/admin-flag are fetched here.
        const [{ data }, { data: adminFlag }] = await Promise.all([
          supabase.from("profiles").select("full_name, avatar_url").eq("id", user.id).maybeSingle(),
          supabase.rpc("is_admin", { p_user: user.id }),
        ]);
        if (cancelled || !data) return;

        const signedAvatarUrl = await signSingleAvatarUrl(data.avatar_url);
        if (cancelled) return;
        const nextProfile = {
          full_name: data.full_name,
          avatar_url: signedAvatarUrl,
          is_admin: Boolean(adminFlag),
        };
        setProfile(nextProfile);
        window.sessionStorage.setItem(cacheKey, JSON.stringify(nextProfile));
      } catch {
        // Header should never block navigation or page rendering.
      }
    };

    void loadProfile();
    window.addEventListener(PROFILE_UPDATED_EVENT, loadProfile);
    return () => {
      cancelled = true;
      window.removeEventListener(PROFILE_UPDATED_EVENT, loadProfile);
    };
  }, [user]);

  const displayName = profile?.full_name ?? user?.email ?? null;
  const sidebarWidth = sidebarCollapsed ? 72 : 192;
  const resolvedNav: NavItem[] = NAV_ITEMS.map((item) =>
    item.name === "Home" ? { ...item, to: user ? "/dashboard" : "/" } : item,
  );
  if (profile?.is_admin) {
    resolvedNav.push({ name: "Admin", icon: ShieldCheck, to: "/admin" });
  }

  const handleSignOut = async () => {
    await signOut();
    navigate({ to: "/" });
  };

  return (
    <>
      <aside
        className={cn(
          "fixed left-0 top-0 z-40 hidden h-screen flex-col border-r border-border/50 glass-strong md:flex",
          sidebarCollapsed ? "w-[72px]" : "w-48",
        )}
      >
        <div className="flex h-16 items-center border-b border-border/50 px-4">
          <Link
            to={user ? "/dashboard" : "/"}
            className={cn("flex min-w-0 items-center gap-3", sidebarCollapsed && "justify-center")}
          >
            <Logo size="sm" showText={!sidebarCollapsed} />
          </Link>
        </div>

        <nav className="flex-1 space-y-2 px-3 py-6">
          {resolvedNav.map((item) => (
            <SidebarItem
              key={item.name}
              item={item}
              active={isItemActive(item, pathname, Boolean(user))}
              collapsed={sidebarCollapsed}
            />
          ))}
        </nav>

        <div className="border-t border-border/50 p-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleSidebar}
            className={cn("h-10 rounded-xl", sidebarCollapsed ? "mx-auto w-10" : "w-full")}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </Button>
        </div>
      </aside>

      <header
        className={cn(
          "fixed right-0 top-0 z-30 hidden h-16 items-center justify-between border-b border-border/50 px-5 glass md:flex md:[left:var(--sidebar-width)]",
        )}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <div className="w-full max-w-md">
          <Suspense
            fallback={
              <div className="h-10 w-full rounded-full border border-border/40 bg-card/40" />
            }
          >
            <GlobalSearch />
          </Suspense>
        </div>

        <div className="flex items-center gap-2">
          {user && (
            <Link
              to="/credits"
              className="flex min-w-[104px] items-center gap-2 rounded-xl border border-accent/20 bg-accent/10 px-3 py-2 text-sm font-semibold text-accent transition-colors hover:bg-accent/20"
            >
              <span className="h-2 w-2 rounded-full bg-accent" />
              {creditBalance === undefined ? (
                <Skeleton className="h-4 w-16 rounded-full bg-accent/20" />
              ) : (
                <>{creditBalance ?? 0} credits</>
              )}
            </Link>
          )}
          {user && <StrikeIndicator />}
          <ThemeToggle />
          {user && <NotificationsMenu />}
          {user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="rounded-xl transition-transform hover:scale-105">
                  <UserAvatar
                    name={displayName}
                    url={profile?.avatar_url}
                    className="h-9 w-9 rounded-xl"
                  />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="glass-strong w-56">
                <div className="px-2 py-2">
                  <div className="truncate text-sm font-medium">{user.email}</div>
                  <div className="text-xs text-muted-foreground">Signed in</div>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate({ to: "/dashboard" })}>
                  <LayoutDashboard className="mr-2 h-4 w-4" /> Dashboard
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate({ to: "/profile" })}>
                  <UserIcon className="mr-2 h-4 w-4" /> Profile
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate({ to: "/history" })}>
                  <History className="mr-2 h-4 w-4" /> History
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleSignOut}>
                  <LogOut className="mr-2 h-4 w-4" /> Sign Out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" asChild>
                <Link to="/login" search={{ redirect: "/dashboard" }}>
                  Log In
                </Link>
              </Button>
              <Button variant="hero" size="sm" asChild>
                <Link to="/signup" search={{ redirect: "/onboarding" }}>
                  Sign Up
                </Link>
              </Button>
            </div>
          )}
        </div>
      </header>

      <header className="fixed inset-x-0 top-0 z-40 border-b border-border/50 glass pt-[env(safe-area-inset-top)] md:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <Link to={user ? "/dashboard" : "/"} className="flex items-center">
            <Logo size="sm" />
          </Link>
          <div className="flex items-center gap-2">
            {user && (
              <Link
                to="/credits"
                className="flex min-w-[52px] items-center gap-1.5 rounded-lg bg-accent/10 px-2 py-1 text-sm font-semibold text-accent"
              >
                <Coins className="h-3.5 w-3.5" />
                {creditBalance === undefined ? (
                  <Skeleton className="h-4 w-8 rounded-full bg-accent/20" />
                ) : (
                  <>{creditBalance ?? 0}</>
                )}
              </Link>
            )}
            {user && <StrikeIndicator />}
            <ThemeToggle />
            {user && <NotificationsMenu />}
            {user && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="rounded-xl transition-transform hover:scale-105">
                    <UserAvatar
                      name={displayName}
                      url={profile?.avatar_url}
                      className="h-9 w-9 rounded-xl"
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="glass-strong w-56">
                  <div className="px-2 py-2">
                    <div className="truncate text-sm font-medium">{user.email}</div>
                    <div className="text-xs text-muted-foreground">Signed in</div>
                  </div>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => navigate({ to: "/dashboard" })}>
                    <LayoutDashboard className="mr-2 h-4 w-4" /> Dashboard
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate({ to: "/profile" })}>
                    <UserIcon className="mr-2 h-4 w-4" /> Profile
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate({ to: "/history" })}>
                    <History className="mr-2 h-4 w-4" /> History
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleSignOut}>
                    <LogOut className="mr-2 h-4 w-4" /> Sign Out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        <div className="px-4 pb-3">
          <Suspense
            fallback={
              <div className="h-9 w-full rounded-full border border-border/40 bg-card/40" />
            }
          >
            <GlobalSearch compact />
          </Suspense>
        </div>
      </header>

      <nav
        aria-label="Primary"
        className="fixed bottom-0 left-0 right-0 z-50 border-t border-border/50 px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] glass-strong md:hidden"
      >
        <div className="flex items-center justify-around">
          {resolvedNav
            .filter((item) => item.name !== "Credits")
            .map((item) => (
              <MobileNavItem
                key={item.name}
                item={item}
                active={isItemActive(item, pathname, Boolean(user))}
              />
            ))}
        </div>
      </nav>
    </>
  );
}

export const SiteHeader = memo(SiteHeaderInner);
SiteHeader.displayName = "SiteHeader";
