-- Anti-circumvention: block phone numbers, external meeting links, and email
-- addresses from being shared inside session chat messages.
-- Mirrors the client-side filter in src/lib/messageFilter.ts.
-- Update both together when changing the rules.

CREATE OR REPLACE FUNCTION public.check_message_safe()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_phone_match TEXT;
  v_digits      TEXT;
BEGIN
  -- Phone heuristic: a chunk that looks like phone formatting AND has 7-15 digits.
  v_phone_match := substring(NEW.text FROM '\+?[0-9][0-9\s\.\-\(\)]{6,}[0-9]');
  IF v_phone_match IS NOT NULL THEN
    v_digits := regexp_replace(v_phone_match, '[^0-9]', '', 'g');
    IF length(v_digits) BETWEEN 7 AND 15 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Sharing phone numbers in chat is not allowed. Keep conversations on SkillSwap.';
    END IF;
  END IF;

  -- Known external meeting / video calling hosts.
  IF NEW.text ~* '(zoom\.us|zoom\.com|zoomgov\.com|meet\.google\.com|g\.co/meet|teams\.microsoft\.com|teams\.live\.com|webex\.com|skype\.com|whereby\.com|jitsi\.org|meet\.jit\.si|hangouts\.google\.com|discord\.gg|discord\.com|tencentmeeting\.com|voov\.com|wherever\.video)' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Sharing external meeting links in chat is not allowed. Keep conversations on SkillSwap.';
  END IF;

  -- Email addresses.
  IF NEW.text ~* '[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Sharing email addresses in chat is not allowed. Keep conversations on SkillSwap.';
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS messages_check_safe_insert ON public.messages;
CREATE TRIGGER messages_check_safe_insert
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.check_message_safe();
DROP TRIGGER IF EXISTS messages_check_safe_update ON public.messages;
CREATE TRIGGER messages_check_safe_update
  BEFORE UPDATE OF text ON public.messages
  FOR EACH ROW
  WHEN (NEW.text IS DISTINCT FROM OLD.text)
  EXECUTE FUNCTION public.check_message_safe();
REVOKE EXECUTE ON FUNCTION public.check_message_safe() FROM PUBLIC, anon, authenticated;
