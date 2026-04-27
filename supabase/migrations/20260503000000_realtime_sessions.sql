-- Make session lifecycle events visible to subscribed clients (dashboard
-- "Active Sessions" list, session detail page) without a manual refresh.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.sessions;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END;
$$;
