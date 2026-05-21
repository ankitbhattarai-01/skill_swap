-- Backfill full_name for profiles that pre-date the handle_new_user trigger
-- or were seeded directly without a name. Symptom: the inbox showed every
-- such user as "Student" because the client falls back to that literal when
-- profile.full_name is null.
--
-- Source of truth is auth.users.email (the part before '@') — same fallback
-- the trigger uses for OAuth signups that don't pass a name.

UPDATE public.profiles p
SET full_name = split_part(u.email, '@', 1)
FROM auth.users u
WHERE p.id = u.id
  AND (p.full_name IS NULL OR btrim(p.full_name) = '')
  AND u.email IS NOT NULL
  AND u.email <> '';
