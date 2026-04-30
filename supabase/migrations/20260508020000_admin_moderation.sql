-- Phase 4: admin role + moderation queue + audit log.

-- ─── Admin flag on profiles ──────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
-- Helper: SECURITY DEFINER so RLS policies on `reports` etc. can call it
-- without recursing back through the profiles policies.
CREATE OR REPLACE FUNCTION public.is_admin(p_user uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = p_user AND is_admin = true
  );
$$;
GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO authenticated;
-- Stop normal users from promoting themselves. Direct SQL editor (service role)
-- bypasses this because auth.uid() is NULL there, so the very first admin can
-- still be created from the dashboard.
CREATE OR REPLACE FUNCTION public.protect_admin_flag()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL
     AND NEW.is_admin IS DISTINCT FROM OLD.is_admin
     AND NOT public.is_admin(auth.uid())
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Only admins can change admin status.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS profiles_protect_admin ON public.profiles;
CREATE TRIGGER profiles_protect_admin
  BEFORE UPDATE OF is_admin ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_admin_flag();
REVOKE EXECUTE ON FUNCTION public.protect_admin_flag() FROM PUBLIC, anon, authenticated;
-- ─── Admin RLS bypass for reports ────────────────────────────────────────────
DROP POLICY IF EXISTS "Admins view all reports" ON public.reports;
CREATE POLICY "Admins view all reports" ON public.reports
  FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()));
DROP POLICY IF EXISTS "Admins update reports" ON public.reports;
CREATE POLICY "Admins update reports" ON public.reports
  FOR UPDATE TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));
-- ─── Audit log for moderation actions ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.report_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES public.reports(id) ON DELETE CASCADE,
  moderator_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('status_change', 'note_added')),
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_actions_report_idx
  ON public.report_actions (report_id, created_at DESC);
ALTER TABLE public.report_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins view audit log" ON public.report_actions;
CREATE POLICY "Admins view audit log" ON public.report_actions
  FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()));
DROP POLICY IF EXISTS "Admins create audit entries" ON public.report_actions;
CREATE POLICY "Admins create audit entries" ON public.report_actions
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin(auth.uid())
    AND auth.uid() = moderator_id
  );
-- Auto-log every report status change.
CREATE OR REPLACE FUNCTION public.log_report_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.report_actions (report_id, moderator_id, action, from_status, to_status)
    VALUES (NEW.id, auth.uid(), 'status_change', OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS reports_log_status ON public.reports;
CREATE TRIGGER reports_log_status
  AFTER UPDATE ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.log_report_status_change();
REVOKE EXECUTE ON FUNCTION public.log_report_status_change() FROM PUBLIC, anon, authenticated;
