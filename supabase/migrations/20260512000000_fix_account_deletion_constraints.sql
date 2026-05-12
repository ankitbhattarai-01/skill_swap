-- Keep self-serve account deletion working after the enterprise admin tables
-- were added. Durable moderation/governance records should survive as
-- tombstones instead of blocking auth.users deletion or disappearing with the
-- deleted account.

DO $$
BEGIN
  IF to_regclass('public.reports') IS NOT NULL THEN
    ALTER TABLE public.reports
      DROP CONSTRAINT IF EXISTS reports_reporter_id_fkey;

    ALTER TABLE public.reports
      ALTER COLUMN reporter_id DROP NOT NULL;

    ALTER TABLE public.reports
      ADD CONSTRAINT reports_reporter_id_fkey
        FOREIGN KEY (reporter_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.admin_action_requests') IS NOT NULL THEN
    ALTER TABLE public.admin_action_requests
      DROP CONSTRAINT IF EXISTS admin_action_requests_maker_id_fkey,
      DROP CONSTRAINT IF EXISTS admin_action_requests_checker_id_fkey;

    ALTER TABLE public.admin_action_requests
      ALTER COLUMN maker_id DROP NOT NULL;

    ALTER TABLE public.admin_action_requests
      ADD CONSTRAINT admin_action_requests_maker_id_fkey
        FOREIGN KEY (maker_id) REFERENCES auth.users(id) ON DELETE SET NULL,
      ADD CONSTRAINT admin_action_requests_checker_id_fkey
        FOREIGN KEY (checker_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END;
$$;

-- Cancel still-pending maker/checker work owned by the deleting account before
-- the FK tombstones are applied. Completed/rejected/executed requests remain
-- unchanged except for maker/checker becoming NULL through ON DELETE SET NULL.
CREATE OR REPLACE FUNCTION public.delete_my_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = v_uid
        AND p.is_admin = true
    )
    OR (
      to_regclass('public.admin_role_assignments') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.admin_role_assignments a
        WHERE a.user_id = v_uid
          AND a.revoked_at IS NULL
          AND a.starts_at <= now()
          AND (a.expires_at IS NULL OR a.expires_at > now())
      )
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    WHERE p.id <> v_uid
      AND p.is_admin = true
    UNION
    SELECT 1
    FROM public.admin_role_assignments a
    JOIN auth.users u ON u.id = a.user_id
    WHERE a.user_id <> v_uid
      AND a.revoked_at IS NULL
      AND a.starts_at <= now()
      AND (a.expires_at IS NULL OR a.expires_at > now())
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Assign another admin before deleting your account.';
  END IF;

  IF to_regclass('public.admin_action_requests') IS NOT NULL THEN
    UPDATE public.admin_action_requests
    SET status = 'cancelled',
        checker_id = NULL,
        decided_at = COALESCE(decided_at, now())
    WHERE status = 'pending'
      AND (maker_id = v_uid OR checker_id = v_uid);
  END IF;

  DELETE FROM auth.users WHERE id = v_uid;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_my_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_my_account() TO authenticated;
