import { Outlet, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { AdminSubNav } from "@/components/AdminSubNav";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { hasAuthRedirectParams } from "@/lib/auth-redirect";
import { useAdminPermissions } from "@/lib/admin";

export const Route = createFileRoute("/admin")({
  // Route-level guard. Runs before the layout component (and any cached child
  // route) mounts, so a non-admin can't briefly see the admin chrome on a
  // direct navigation. We keep the in-component checks in AdminLayout too -
  // they cover the auth-loading window and the case where this beforeLoad
  // returned early on the server (Supabase session lives in localStorage and
  // is unavailable to SSR, so we only guard client-side here).
  beforeLoad: async ({ location }) => {
    if (typeof window === "undefined") return;
    if (hasAuthRedirectParams()) return;

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }

    const { data, error } = await supabase.rpc("get_my_admin_permissions");
    if (error || (data ?? []).length === 0) {
      throw redirect({ to: "/dashboard" });
    }
  },
  component: AdminLayout,
});

function AdminLayout() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  // Each child route also runs its own permission check, but without a gate
  // on the parent the sub-nav and any cached child content render for a beat
  // before the child redirects. Failing fast here means non-admins never see
  // even the admin chrome (which leaks the surface area of the panel) and
  // can't navigate between admin tabs mid-load.
  const permissionsQuery = useAdminPermissions();

  useEffect(() => {
    if (!authLoading && !user) {
      navigate({ to: "/login", search: { redirect: "/admin" } });
    }
  }, [authLoading, navigate, user]);

  useEffect(() => {
    if (!user) return;
    if (permissionsQuery.isLoading) return;
    const permissions = permissionsQuery.data ?? [];
    if (permissions.length === 0) {
      navigate({ to: "/dashboard" });
    }
  }, [navigate, permissionsQuery.data, permissionsQuery.isLoading, user]);

  // Don't paint the admin shell until we've confirmed the caller has at
  // least one admin permission. Any signed-out / not-yet-loaded / non-admin
  // state renders a neutral loader.
  if (
    authLoading ||
    !user ||
    permissionsQuery.isLoading ||
    (permissionsQuery.data ?? []).length === 0
  ) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <AdminSubNav />
      <Outlet />
    </>
  );
}
