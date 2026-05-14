-- Supabase security advisor: Function Search Path Mutable.
-- Fix the helper's search_path without changing its behavior or grants.
ALTER FUNCTION public.admin_mask_email(TEXT) SET search_path = public, pg_temp;
