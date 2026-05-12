-- Seed real settings into admin_active_settings so the admin Settings page has
-- meaningful rows to display, and expose a small public reader so the rest of
-- the app can honour the seeded feature flags.

INSERT INTO public.admin_active_settings (setting_key, current_version_id, current_value, published_by, published_at, updated_at)
VALUES
  ('signup.starting_credits',          NULL, jsonb_build_object('value', 10),       NULL, now(), now()),
  ('sessions.default_credits_per_hour',NULL, jsonb_build_object('value', 5),        NULL, now(), now()),
  ('features.ai_suggestions.enabled',  NULL, jsonb_build_object('enabled', true),   NULL, now(), now()),
  ('features.video_calls.enabled',     NULL, jsonb_build_object('enabled', true),   NULL, now(), now()),
  ('features.public_explore.enabled',  NULL, jsonb_build_object('enabled', true),   NULL, now(), now())
ON CONFLICT (setting_key) DO NOTHING;
-- Public-but-authenticated reader for whitelisted feature flags. Returns a
-- single JSONB object keyed by setting_key, value = current_value. Any client
-- can call this without holding the 'settings' admin permission, because only
-- non-sensitive flag keys are returned.
CREATE OR REPLACE FUNCTION public.get_admin_feature_flags()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_object_agg(setting_key, current_value),
    '{}'::jsonb
  )
  FROM public.admin_active_settings
  WHERE setting_key IN (
    'features.ai_suggestions.enabled',
    'features.video_calls.enabled',
    'features.public_explore.enabled',
    'signup.starting_credits',
    'sessions.default_credits_per_hour'
  );
$$;
REVOKE EXECUTE ON FUNCTION public.get_admin_feature_flags() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_feature_flags() TO authenticated;
-- Wire signup credit grant to the seeded setting (falls back to 10 if absent).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_starting_credits INT;
BEGIN
  SELECT COALESCE((current_value->>'value')::INT, 10)
  INTO v_starting_credits
  FROM public.admin_active_settings
  WHERE setting_key = 'signup.starting_credits';

  INSERT INTO public.profiles (id, full_name, credits)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    COALESCE(v_starting_credits, 10)
  );
  RETURN NEW;
END;
$$;
