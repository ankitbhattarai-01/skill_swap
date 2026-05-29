-- Dummy data for testing the dashboard "People who can teach you" section.
-- Adds an Advanced Python teacher in collaboration mode that matches Utsab's
-- learning list, so the visual changes show up immediately.
--
-- Safe to re-run: every step is idempotent (ON CONFLICT DO NOTHING / UPDATE).
--
-- HOW TO RUN
--   1. Open https://supabase.com/dashboard/project/hgkgeosmpsznumuhqrck/sql/new
--   2. Paste this entire file.
--   3. Click Run. The final SELECT prints what was inserted.
--
-- HOW TO REVERT (cleanup script at the bottom of this file, commented out).

DO $$
DECLARE
  v_utsab_id     uuid;
  v_teacher_id   uuid;
  v_skill_id     uuid;
BEGIN
  -- 1. Find Utsab by email. Bail out loudly if the account isn't there.
  SELECT id INTO v_utsab_id
  FROM auth.users
  WHERE email = 'utsabkarki1377@gmail.com'
  LIMIT 1;

  IF v_utsab_id IS NULL THEN
    RAISE EXCEPTION 'Could not find Utsab account by email utsabkarki1377@gmail.com';
  END IF;

  -- 2. Ensure the "Python" skill exists, capture its id.
  INSERT INTO public.skills (name, category)
  VALUES ('Python', 'Programming')
  ON CONFLICT (name) DO NOTHING;

  SELECT id INTO v_skill_id FROM public.skills WHERE name = 'Python' LIMIT 1;

  -- 3. Make sure Utsab is learning Python (intermediate, collaboration), so the
  --    dashboard match-finder includes Python teachers for him.
  INSERT INTO public.user_learning_skills (user_id, skill_id, current_level, learning_mode)
  VALUES (v_utsab_id, v_skill_id, 'intermediate', 'collaboration')
  ON CONFLICT (user_id, skill_id) DO UPDATE
    SET learning_mode = EXCLUDED.learning_mode;

  -- 4. Pick a teacher: any other onboarded profile that is NOT already teaching
  --    Python at advanced+collaboration. Prefers users who don't teach Python
  --    yet (most visible change), falls back to anyone else.
  SELECT p.id INTO v_teacher_id
  FROM public.profiles p
  WHERE p.id <> v_utsab_id
    AND p.onboarded = true
    AND NOT EXISTS (
      SELECT 1 FROM public.user_teaching_skills uts
      WHERE uts.user_id = p.id
        AND uts.skill_id = v_skill_id
        AND uts.level = 'advanced'
        AND uts.teaching_mode = 'collaboration'
    )
  ORDER BY
    (EXISTS (SELECT 1 FROM public.user_teaching_skills uts
             WHERE uts.user_id = p.id AND uts.skill_id = v_skill_id)) ASC,
    p.created_at ASC
  LIMIT 1;

  IF v_teacher_id IS NULL THEN
    RAISE EXCEPTION 'No other onboarded profile available to act as a dummy Python teacher';
  END IF;

  -- 5. Add (or upgrade) that user's Python teaching row to advanced + collaboration.
  INSERT INTO public.user_teaching_skills
    (user_id, skill_id, level, credits_per_hour, teaching_mode)
  VALUES
    (v_teacher_id, v_skill_id, 'advanced', 4, 'collaboration')
  ON CONFLICT (user_id, skill_id) DO UPDATE
    SET level = 'advanced',
        teaching_mode = 'collaboration',
        credits_per_hour = 4;

  RAISE NOTICE 'Seeded: teacher % now teaches Python at advanced + collaboration', v_teacher_id;
END $$;

-- Show what's in place for sanity.
SELECT
  p.full_name AS teacher,
  s.name      AS skill,
  uts.level,
  uts.teaching_mode,
  uts.credits_per_hour
FROM public.user_teaching_skills uts
JOIN public.profiles p ON p.id = uts.user_id
JOIN public.skills   s ON s.id = uts.skill_id
WHERE s.name = 'Python'
ORDER BY uts.level DESC, p.full_name ASC;

-- =============================================================================
-- CLEANUP (uncomment + run to undo). Removes ONLY the advanced+collaboration
-- Python teaching row added above. Does NOT remove Utsab's learning row, since
-- you may have wanted that anyway.
-- =============================================================================
--
-- DELETE FROM public.user_teaching_skills uts
-- USING public.skills s
-- WHERE uts.skill_id = s.id
--   AND s.name = 'Python'
--   AND uts.level = 'advanced'
--   AND uts.teaching_mode = 'collaboration';
