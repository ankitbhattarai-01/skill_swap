-- Enforce MIME type and size limits on the avatars bucket.
--
-- Before: the bucket only restricted who could write where (folder-per-user),
-- so an authenticated user could upload arbitrary content into their own
-- folder using the raw storage API and use SkillSwap as a free file host
-- (SEC-007 in the audit). The React UI did a client-side type/size check
-- which a determined caller can simply skip.
--
-- After: storage.buckets carries the canonical allow-list. The Storage API
-- rejects uploads outside the MIME types or larger than the size cap before
-- they ever hit our policies, so the protection cannot be bypassed by
-- choosing a different SDK or hitting the REST endpoint directly.
--
--   * Allowed types: image/png, image/jpeg, image/webp, image/gif
--   * Size cap: 2 MiB — matches the existing client-side validation in
--     src/routes/profile.tsx so legitimate uploads keep working.

UPDATE storage.buckets
SET
  file_size_limit = 2 * 1024 * 1024,
  allowed_mime_types = ARRAY[
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif'
  ]
WHERE id = 'avatars';
