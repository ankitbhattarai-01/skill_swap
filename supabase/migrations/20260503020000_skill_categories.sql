-- Backfill missing categories so the explore filter and badges always have a value.
UPDATE public.skills SET category = 'Other' WHERE category IS NULL;
-- New skills created by users via the app default to 'Other' until categorised.
ALTER TABLE public.skills ALTER COLUMN category SET DEFAULT 'Other';
ALTER TABLE public.skills ALTER COLUMN category SET NOT NULL;
CREATE INDEX IF NOT EXISTS skills_category_idx ON public.skills (category);
