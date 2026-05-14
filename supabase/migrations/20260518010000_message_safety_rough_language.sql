-- Extend chat safety filtering to block rough language.
-- Mirrors src/lib/messageFilter.ts. Keep the ROUGH_LANGUAGE regex in sync.

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

  -- Strong profanity / abusive language. Word boundaries avoid substring false positives.
  IF NEW.text ~* '\m(arseholes?|assholes?|bastards?|bitch(es)?|bullshits?|cunts?|douchebags?|fuck(s|ed|er|ers|ing)?|motherfucker(s)?|pricks?|shit(s|ty)?|sluts?|whores?)\M' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Rough language is not allowed in chat. Please keep conversations respectful.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_message_safe() FROM PUBLIC, anon, authenticated;
