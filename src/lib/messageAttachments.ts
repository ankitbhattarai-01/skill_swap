import { supabase } from "@/integrations/supabase/client";

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_BUCKET = "message-attachments";

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
]);

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
export const DOCUMENT_ACCEPT =
  ".pdf,.docx,.xlsx,.pptx,.txt,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/csv";

export type AttachmentKind = "image" | "document";

export type AttachmentMeta = {
  path: string;
  kind: AttachmentKind;
  name: string;
  size: number;
  mime: string;
};

export type ValidatedAttachment =
  | { ok: true; kind: AttachmentKind; mime: string }
  | { ok: false; reason: string };

// Some browsers report `.docx`/`.xlsx` as application/octet-stream or empty
// when dropped from certain folders; fall back to extension when needed.
const EXT_MIME_FALLBACK: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

function resolveMime(file: File): string {
  if (file.type && (IMAGE_MIME_TYPES.has(file.type) || DOCUMENT_MIME_TYPES.has(file.type))) {
    return file.type;
  }
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME_FALLBACK[ext] ?? file.type ?? "";
}

export function validateAttachment(file: File, expected: AttachmentKind): ValidatedAttachment {
  if (file.size <= 0) return { ok: false, reason: "File is empty." };
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return { ok: false, reason: "File is larger than 5 MB." };
  }
  const mime = resolveMime(file);
  if (expected === "image") {
    if (!IMAGE_MIME_TYPES.has(mime)) {
      return { ok: false, reason: "Unsupported image type. Use PNG, JPEG, WebP, or GIF." };
    }
    return { ok: true, kind: "image", mime };
  }
  if (!DOCUMENT_MIME_TYPES.has(mime)) {
    return {
      ok: false,
      reason: "Unsupported document type. Use PDF, DOCX, XLSX, PPTX, TXT, or CSV.",
    };
  }
  return { ok: true, kind: "document", mime };
}

function safeFileName(name: string): string {
  // Storage object keys can technically hold many characters but signed URLs
  // are cleaner when we strip path separators and trim length.
  const cleaned = name.replace(/[\\/]+/g, "_").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 120) || "file";
}

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function uploadMessageAttachment(args: {
  file: File;
  kind: AttachmentKind;
  mime: string;
  sessionId: string;
  userId: string;
}): Promise<AttachmentMeta> {
  const { file, kind, mime, sessionId, userId } = args;
  const ext = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  const objectKey = `${sessionId}/${userId}/${randomId()}${ext ? `.${ext}` : ""}`;
  const { error } = await supabase.storage.from(ATTACHMENT_BUCKET).upload(objectKey, file, {
    cacheControl: "3600",
    contentType: mime,
    upsert: false,
  });
  if (error) throw error;
  return {
    path: objectKey,
    kind,
    name: safeFileName(file.name),
    size: file.size,
    mime,
  };
}

const SIGNED_URL_TTL_SECONDS = 60 * 60;
const SIGNED_URL_CACHE_MAX_AGE_MS = 50 * 60 * 1000;
const signedUrlCache = new Map<string, { url: string; savedAt: number }>();

export async function signAttachmentUrl(path: string): Promise<string | null> {
  const cached = signedUrlCache.get(path);
  if (cached && Date.now() - cached.savedAt < SIGNED_URL_CACHE_MAX_AGE_MS) {
    return cached.url;
  }
  const { data, error } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) return null;
  signedUrlCache.set(path, { url: data.signedUrl, savedAt: Date.now() });
  return data.signedUrl;
}

export async function signAttachmentUrls(paths: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(paths.filter(Boolean)));
  const map = new Map<string, string>();
  const missing: string[] = [];
  const now = Date.now();
  for (const p of unique) {
    const cached = signedUrlCache.get(p);
    if (cached && now - cached.savedAt < SIGNED_URL_CACHE_MAX_AGE_MS) {
      map.set(p, cached.url);
    } else {
      missing.push(p);
    }
  }
  if (missing.length === 0) return map;
  try {
    const { data } = await supabase.storage
      .from(ATTACHMENT_BUCKET)
      .createSignedUrls(missing, SIGNED_URL_TTL_SECONDS);
    for (const item of data ?? []) {
      if (item.path && item.signedUrl) {
        map.set(item.path, item.signedUrl);
        signedUrlCache.set(item.path, { url: item.signedUrl, savedAt: Date.now() });
      }
    }
  } catch {
    // Fall through — caller renders a fallback when the URL is missing.
  }
  return map;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Forces a real download instead of navigating. The HTML `download` attribute
// is ignored for cross-origin URLs (Supabase storage lives on a different
// host), so we fetch the bytes ourselves and feed a blob: URL into a
// synthetic anchor — those obey the `download` attribute.
export async function downloadAttachment(url: string, filename: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename || "download";
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Defer revoke so Safari/Firefox have time to start the download.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
  }
}
