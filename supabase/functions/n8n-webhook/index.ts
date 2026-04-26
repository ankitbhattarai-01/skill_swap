// Authenticated server-side proxy for optional n8n webhooks.
//
// Configure these with `supabase secrets set ...`; never expose them as
// VITE_* browser variables:
//   N8N_RECOMMENDATION_WEBHOOK_URL
//   N8N_CREDIT_TRANSFER_WEBHOOK_URL
//   N8N_WEBHOOK_SECRET

import { createClient } from "jsr:@supabase/supabase-js@2";
import { z } from "npm:zod@3";
import { corsJson, corsPreflight } from "../_shared/cors.ts";

// Boundary schemas. Anything that doesn't match is rejected with 400 before
// it can touch business logic — closes VAL-001 from the audit (validation
// drift across UI / SQL / functions).
const Uuid = z.string().uuid();

const RecommendationPayloadSchema = z.object({
  userId: Uuid,
  teachingSkills: z.array(z.string().max(120)).max(50).optional(),
  learningSkills: z.array(z.string().max(120)).max(50).optional(),
});

const CreditTransferPayloadSchema = z.object({
  fromUser: Uuid,
  toUser: Uuid,
  amount: z.number().int().positive().max(1_000_000),
  sessionId: Uuid,
});

const RequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("recommendation"), payload: RecommendationPayloadSchema }),
  z.object({ type: z.literal("credit-transfer"), payload: CreditTransferPayloadSchema }),
]);

type RecommendationPayload = z.infer<typeof RecommendationPayloadSchema>;
type CreditTransferPayload = z.infer<typeof CreditTransferPayloadSchema>;

async function signedJsonInit(payload: unknown): Promise<RequestInit> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = Deno.env.get("N8N_WEBHOOK_SECRET");

  if (secret) {
    const timestamp = String(Date.now());
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`));
    const hex = Array.from(new Uint8Array(signature))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    headers["X-SkillSwap-Timestamp"] = timestamp;
    headers["X-SkillSwap-Signature"] = `sha256=${hex}`;
  }

  return { method: "POST", headers, body };
}

const rateLimit = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string, max = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  // Opportunistically reclaim expired entries so the map can't grow unbounded.
  for (const [k, v] of rateLimit) {
    if (v.resetAt <= now) rateLimit.delete(k);
  }
  const entry = rateLimit.get(key);
  if (!entry || entry.resetAt <= now) {
    rateLimit.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count += 1;
  return true;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("n8n webhook request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function postWebhook(url: string, payload: unknown) {
  const response = await fetchWithTimeout(url, await signedJsonInit(payload));
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`n8n webhook failed ${response.status}: ${body.slice(0, 200)}`);
  }
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight(req);
  const json = (status: number, body: Record<string, unknown>) => corsJson(req, status, body);
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { error: "Missing Authorization header" });

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) return json(401, { error: "Unauthorized" });
    const user = userData.user;

    const rawBody = await req.json().catch(() => null);
    const parsed = RequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return json(400, {
        error: "Invalid request body",
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    const body = parsed.data;

    if (body.type === "recommendation") {
      const payload: RecommendationPayload = body.payload;
      if (payload.userId !== user.id) {
        return json(403, { error: "Cannot request recommendations for another user" });
      }

      const url = Deno.env.get("N8N_RECOMMENDATION_WEBHOOK_URL");
      if (!url) return json(200, { recommendations: null, configured: false });

      if (!checkRateLimit(`${user.id}:${body.type}`)) {
        return json(429, { error: "Too many webhook requests" });
      }

      const result = await postWebhook(url, payload);
      return json(200, { recommendations: result, configured: true });
    }

    if (body.type === "credit-transfer") {
      const payload: CreditTransferPayload = body.payload;

      const { data: session, error: sessionError } = await supabase
        .from("sessions")
        .select("id, learner_id, teacher_id, credits, status")
        .eq("id", payload.sessionId)
        .maybeSingle();
      if (sessionError || !session) return json(404, { error: "Session not found" });
      if (session.learner_id !== user.id && session.teacher_id !== user.id) {
        return json(403, { error: "Not a participant of this session" });
      }
      if (session.status !== "completed") {
        return json(400, { error: "Credit transfer events require a completed session" });
      }
      if (
        payload.fromUser !== session.learner_id ||
        payload.toUser !== session.teacher_id ||
        payload.amount !== session.credits
      ) {
        return json(400, { error: "Credit payload does not match the session" });
      }

      const url = Deno.env.get("N8N_CREDIT_TRANSFER_WEBHOOK_URL");
      if (!url) return json(200, { ok: true, configured: false });

      if (!checkRateLimit(`${user.id}:${body.type}`)) {
        return json(429, { error: "Too many webhook requests" });
      }

      await postWebhook(url, payload);
      return json(200, { ok: true, configured: true });
    }

    return json(400, { error: "Unsupported webhook type" });
  } catch (error) {
    // Don't echo raw upstream/fetch error messages back to the caller.
    console.error("[n8n-webhook] unhandled error", error);
    return json(500, { error: "Internal error" });
  }
});
