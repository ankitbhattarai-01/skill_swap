-- Harden skill catalog writes.
--
-- Anyone authenticated can INSERT into public.skills (the catalog is shared).
-- Without this migration, the name and category columns have no length cap,
-- no content filter, and no shape validation. A malicious user could pollute
-- the public catalog with 100KB skill names, profanity, phone numbers, or
-- meeting links to circumvent the chat filter.
--
-- Skill names also flow into:
--   - the skills view (public read)
--   - the AI suggestions prompt (Gemini)
--   - notifications (title/body)
--   - global search results
--
-- React renders these as text so XSS is not a vector, but spam, abuse, and
-- platform-quality issues are. This migration adds:
--   1. Length caps on name (1..60) and category (1..40)
--   2. Trim + collapse-whitespace normaliser
--   3. Content-safety trigger that rejects phone numbers, emails, and
--      external meeting links - same rules as messages and reviews
--
-- A per-user rate limit is NOT added here because public.skills has no
-- creator_id column. If catalog spam becomes a real problem, add a
-- creator_id (default auth.uid()) and a 24h limit on inserts.

-- 1. Length and shape constraints. NOT VALID so existing rows aren't blocked.
ALTER TABLE public.skills
  DROP CONSTRAINT IF EXISTS skills_name_length;
ALTER TABLE public.skills
  ADD CONSTRAINT skills_name_length
  CHECK (char_length(btrim(name)) BETWEEN 1 AND 60) NOT VALID;
ALTER TABLE public.skills
  DROP CONSTRAINT IF EXISTS skills_category_length;
ALTER TABLE public.skills
  ADD CONSTRAINT skills_category_length
  CHECK (char_length(btrim(category)) BETWEEN 1 AND 40) NOT VALID;
-- 2. + 3. Single BEFORE INSERT trigger that normalises and validates.
CREATE OR REPLACE FUNCTION public.check_skill_safe()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone_match TEXT;
  v_digits TEXT;
BEGIN
  -- Normalise: trim, collapse whitespace runs.
  NEW.name := regexp_replace(btrim(NEW.name), '\s+', ' ', 'g');
  IF NEW.category IS NOT NULL THEN
    NEW.category := regexp_replace(btrim(NEW.category), '\s+', ' ', 'g');
  END IF;

  IF NEW.name IS NULL OR length(NEW.name) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Skill name cannot be empty.';
  END IF;

  -- Phone heuristic: a chunk that looks like phone formatting AND has 7-15 digits.
  v_phone_match := substring(NEW.name FROM '\+?[0-9][0-9\s\.\-\(\)]{6,}[0-9]');
  IF v_phone_match IS NOT NULL THEN
    v_digits := regexp_replace(v_phone_match, '[^0-9]', '', 'g');
    IF length(v_digits) BETWEEN 7 AND 15 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Skill names cannot contain phone numbers.';
    END IF;
  END IF;

  -- Known external meeting / video calling hosts (mirrors check_message_safe).
  IF NEW.name ~* '(zoom\.us|zoom\.com|zoomgov\.com|meet\.google\.com|g\.co/meet|teams\.microsoft\.com|teams\.live\.com|webex\.com|skype\.com|whereby\.com|jitsi\.org|meet\.jit\.si|hangouts\.google\.com|discord\.gg|discord\.com|tencentmeeting\.com|voov\.com|wherever\.video)' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Skill names cannot contain external meeting links.';
  END IF;

  -- Email addresses.
  IF NEW.name ~* '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Skill names cannot contain email addresses.';
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS skills_check_safe_insert ON public.skills;
CREATE TRIGGER skills_check_safe_insert
  BEFORE INSERT ON public.skills
  FOR EACH ROW EXECUTE FUNCTION public.check_skill_safe();
REVOKE EXECUTE ON FUNCTION public.check_skill_safe() FROM PUBLIC, anon, authenticated;
-- Profile bio length cap. The original schema declared bio TEXT with no
-- bound. Without a cap, a user could store an arbitrarily large bio that
-- breaks layout, balloons API responses, and inflates the AI prompt.
-- 500 chars matches the cap already enforced on review comments.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_bio_length;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_bio_length
  CHECK (bio IS NULL OR char_length(bio) <= 500) NOT VALID;
-- Profile full_name length cap. Same rationale, also surfaced cross-user
-- (other people see your name in matches, sessions, reviews, notifications).
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_full_name_length;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_full_name_length
  CHECK (full_name IS NULL OR char_length(full_name) BETWEEN 1 AND 80) NOT VALID;
