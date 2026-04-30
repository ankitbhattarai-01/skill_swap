-- Standardise the platform's hourly rate to 4 credits/hour. The column
-- previously defaulted to 5, but no UI lets teachers customise it, so the
-- effective rate has always been the default. This migration realigns the
-- default and backfills existing rows so pricing is uniform across users.
ALTER TABLE public.user_teaching_skills
  ALTER COLUMN credits_per_hour SET DEFAULT 4;
UPDATE public.user_teaching_skills
  SET credits_per_hour = 4;
