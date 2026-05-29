-- Extend chat safety filtering with safe-learning conduct rules:
-- harassment/bullying, hate speech & slurs, threats/self-harm, and sexual
-- content. Mirrors src/lib/messageFilter.ts — keep the regexes and the
-- rejection messages in sync with that file. Conduct checks run before the
-- privacy/anti-circumvention checks so the strongest guidance wins, matching
-- describeViolations() on the client.

CREATE OR REPLACE FUNCTION public.check_message_safe()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_phone_match TEXT;
  v_digits      TEXT;
BEGIN
  -- Hate speech / slurs. Most severe — checked first. Never echo the matched
  -- term back; the generic message intentionally omits it.
  IF NEW.text ~* '\m(n[i1]gg+(er|ers|a|as|ah|uh)|f[a4@]gg?(ot|ots|s)?|r[e3]t[a4]rd(ed|s)?|sp[i1]cs?|k[i1]kes?|g[o0]{2}ks?|w[e3]tbacks?|c[o0]{2}ns?|p[a4]k[i1]s?|b[e3]an[e3]rs?|wops?|d[a4]gos?|towelheads?|tr[a4]nn(y|ie|ies)|sh[e3]m[a4]les?|cr[i1]pples?)\M' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Hate speech and slurs are strictly prohibited. SkillSwap is a space for everyone.';
  END IF;

  -- Threats, violence, and self-harm encouragement.
  IF NEW.text ~* '\m(kys|kill\s+(yourself|urself|you|u)|go\s+(die|kill\s+yourself)|you\s+should\s+die|hope\s+you\s+die|end\s+your\s+life|neck\s+yourself|drink\s+bleach|slit\s+your)\M|\mi(''?ll|\s+will|\s+wanna|\s+want\s+to)\s+(kill|hurt|beat|attack|stab|shoot|find|destroy)\s+(you|u)\M' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Threats and harmful language aren''t allowed. If you or someone you know is struggling, please reach out to a trusted person or a local helpline.';
  END IF;

  -- Sexual / explicit content.
  IF NEW.text ~* '\m(p[o0]rn(o|os|ography|hub)?|d[i1]ck(head|heads|s)?|c[o0]cks?|puss(y|ies)|boobs?|tits?|titties|cumshots?|cumming|blow\s*jobs?|hand\s*jobs?|b[o0]ners?|jerk\s*off|jack\s*off|masturbat(e|es|ed|ing|ion)|horny|nudes?|send\s+nudes)\M' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Sexual or explicit content isn''t allowed in chat. Keep conversations appropriate.';
  END IF;

  -- Bullying / harassment: personal put-downs and toxic phrases.
  IF NEW.text ~* '\m(idiots?|stupid|loser(s)?|morons?|dumb(ass|asses)?|ugly|freaks?|failures?|trash|useless|pathetic|jackass(es)?|dimwits?|imbeciles?)\M|\m(nobody\s+likes\s+you|every(one|body)\s+hates\s+you|you(''?re|\s+are)\s+(worthless|a\s+joke|pathetic|useless)|you\s+should\s+quit|shut\s+up|go\s+away)\M' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Please keep chat kind — insults and put-downs aren''t allowed here.';
  END IF;

  -- Strong profanity / abusive language. Word boundaries avoid substring false positives.
  IF NEW.text ~* '\m(arseholes?|assholes?|bastards?|bitch(es)?|bullshits?|cunts?|douchebags?|fuck(s|ed|er|ers|ing)?|motherfucker(s)?|pricks?|shit(s|ty)?|sluts?|whores?)\M' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Rough language is not allowed in chat. Please keep conversations respectful.';
  END IF;

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

REVOKE EXECUTE ON FUNCTION public.check_message_safe() FROM PUBLIC, anon, authenticated;
