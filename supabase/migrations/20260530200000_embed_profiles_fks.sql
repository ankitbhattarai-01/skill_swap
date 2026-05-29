-- Let PostgREST embed public.profiles directly in user_teaching_skills and
-- user_learning_skills queries.
--
-- Both tables' user_id columns reference auth.users(id), not public.profiles.
-- PostgREST only embeds across foreign keys to tables in the exposed schema,
-- so every list page (explore, incoming requests, etc.) has had to fetch the
-- skill rows first and then issue a *second* round trip for the profiles. That
-- waterfall is the dominant cost of a cold /explore load.
--
-- profiles.id is itself a PK referencing auth.users(id), and a profile row is
-- created for every user via the on_auth_user_created trigger, so every
-- user_id already has a matching profiles row — these FKs validate cleanly and
-- add no orphan risk. ON DELETE CASCADE mirrors the existing auth.users FKs so
-- account deletion keeps working regardless of which cascade fires first.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_teaching_skills_user_id_profiles_fkey'
  ) THEN
    ALTER TABLE public.user_teaching_skills
      ADD CONSTRAINT user_teaching_skills_user_id_profiles_fkey
      FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_learning_skills_user_id_profiles_fkey'
  ) THEN
    ALTER TABLE public.user_learning_skills
      ADD CONSTRAINT user_learning_skills_user_id_profiles_fkey
      FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Refresh PostgREST's schema cache so the new relationships are usable
-- immediately without a restart.
NOTIFY pgrst, 'reload schema';
