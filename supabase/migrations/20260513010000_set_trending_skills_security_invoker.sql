-- Supabase security advisor: views should not run with creator privileges.
-- Keep the trending_skills query shape/grants intact, but make Postgres apply
-- the permissions and RLS policies of the querying role.
ALTER VIEW public.trending_skills SET (security_invoker = true);
