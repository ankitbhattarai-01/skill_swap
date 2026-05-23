// Mints a JaaS (8x8.vc) JWT for an authenticated SkillSwap user, scoped to a
// single session room. Teacher gets moderator: "true", learner gets "false".
//
// Required Supabase secrets:
//   JAAS_APP_ID       - vpaas-magic-cookie-XXXXXXXX...
//   JAAS_KEY_ID       - the public Key ID shown in the JaaS API Keys dashboard
//   JAAS_PRIVATE_KEY  - RSA private key PEM (BEGIN PRIVATE KEY ... END PRIVATE KEY)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { SignJWT, importPKCS8 } from "npm:jose@5";
import { z } from "npm:zod@3";
import { corsJson, corsPreflight } from "../_shared/cors.ts";

const RequestSchema = z.object({ sessionId: z.string().uuid() });

function makeRawRoomName(sessionId: string, skillName?: string | null) {
  const skillPart = (skillName ?? "session")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const sessionPart = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
  return `skillswap-${skillPart || "session"}-${sessionPart}`;
}

function readSecret(name: string) {
  const value = Deno.env.get(name)?.trim();
  return value && value.length > 0 ? value : null;
}

function normalizePrivateKey(value: string) {
  return value
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\n/g, "\n")
    .trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight(req);
  const json = (status: number, body: Record<string, unknown>) => corsJson(req, status, body);
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const APP_ID = readSecret("JAAS_APP_ID");
    const KEY_ID = readSecret("JAAS_KEY_ID");
    const PRIVATE_KEY_PEM = readSecret("JAAS_PRIVATE_KEY");
    if (!APP_ID || !KEY_ID || !PRIVATE_KEY_PEM) {
      return json(500, {
        error:
          "JaaS credentials not configured. Set JAAS_APP_ID, JAAS_KEY_ID, and JAAS_PRIVATE_KEY as Supabase Edge Function secrets.",
      });
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { error: "Missing Authorization header" });

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: "Unauthorized" });
    const user = userData.user;

    // Refuse JaaS tokens for admin-suspended accounts. is_suspended_self()
    // is a SECURITY DEFINER RPC that wraps the private suspension helper —
    // it returns boolean without leaking the suspended_at column to the
    // caller's role. We treat an RPC error as a hard fail rather than
    // letting the call slip through, since failing open here would defeat
    // the purpose of the gate.
    const { data: suspended, error: suspErr } = await supabase.rpc("is_suspended_self");
    if (suspErr) {
      return json(500, { error: "Could not verify account status" });
    }
    if (suspended === true) {
      return json(403, { error: "Your account is suspended and cannot join video calls." });
    }

    const rawBody = await req.json().catch(() => null);
    const parsed = RequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return json(400, {
        error: "sessionId (UUID) is required",
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    const body = parsed.data;

    const { data: session, error: sessErr } = await supabase
      .from("sessions")
      .select("id, learner_id, teacher_id, status, skill_id, scheduled_at, duration_minutes")
      .eq("id", body.sessionId)
      .maybeSingle();

    if (sessErr || !session) return json(404, { error: "Session not found" });
    if (session.learner_id !== user.id && session.teacher_id !== user.id) {
      return json(403, { error: "Not a participant of this session" });
    }
    if (session.status !== "accepted" && session.status !== "active") {
      return json(400, { error: "Session is not in an active state" });
    }

    // Server-side join-window enforcement. Mirrors JOIN_WINDOW_BEFORE_MS /
    // JOIN_WINDOW_AFTER_MS in src/lib/sessions.ts (10 min before scheduled
    // start, 30 min after scheduled end). Keep the constants here in sync
    // with the client lib — they used to drift (10 min server vs 2 min
    // client), which let direct API callers get a token 8 minutes earlier
    // than the UI allowed. Sessions with no scheduled_at fall through
    // (unscheduled = open).
    const JOIN_WINDOW_BEFORE_MS = 10 * 60 * 1000;
    const JOIN_WINDOW_AFTER_MS = 30 * 60 * 1000;
    if (session.scheduled_at) {
      const start = Date.parse(session.scheduled_at);
      if (!Number.isNaN(start)) {
        const durationMs = (session.duration_minutes ?? 60) * 60 * 1000;
        const opensAt = start - JOIN_WINDOW_BEFORE_MS;
        const closesAt = start + durationMs + JOIN_WINDOW_AFTER_MS;
        const nowMs = Date.now();
        if (nowMs < opensAt || nowMs > closesAt) {
          return json(403, { error: "Session is not within its join window" });
        }
      }
    }

    const isTeacher = session.teacher_id === user.id;

    // Server-attested presence: record the join before minting the JWT.
    // Because token-minting is the only path into the JaaS room, this row is
    // the canonical proof that the user actually entered the call. The RPC
    // is SECURITY DEFINER and validates session state, so a failure here
    // (session not joinable, etc.) should block token issuance rather than
    // silently let a user in without an attendance record.
    //
    // We use the service-role key (not the caller's JWT) because the new
    // record_session_join_for() signature is revoked from authenticated to
    // close the "forge attendance via direct RPC call" hole. The caller's
    // identity is the verified `user.id` above, derived from their JWT,
    // and is passed in as p_user_id.
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceRoleKey) {
      return json(500, { error: "Server misconfigured: missing service role key" });
    }
    const adminSupabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceRoleKey);
    const { error: attendanceErr } = await adminSupabase.rpc("record_session_join_for", {
      p_session_id: session.id,
      p_user_id: user.id,
    });
    if (attendanceErr) {
      return json(403, { error: attendanceErr.message || "Could not record attendance" });
    }

    const [{ data: profile }, { data: skill }] = await Promise.all([
      supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
      supabase.from("skills").select("name").eq("id", session.skill_id).maybeSingle(),
    ]);

    const displayName = profile?.full_name ?? user.email?.split("@")[0] ?? "SkillSwap user";
    const roomName = makeRawRoomName(session.id, skill?.name);

    const privateKey = await importPKCS8(normalizePrivateKey(PRIVATE_KEY_PEM), "RS256");
    const now = Math.floor(Date.now() / 1000);

    // Default 2h lifetime, extended to outlast the room's join window so early
    // joiners don't lose their token before the 30-min post-end grace closes.
    let exp = now + 2 * 60 * 60;
    if (session.scheduled_at) {
      const startMs = Date.parse(session.scheduled_at);
      if (!Number.isNaN(startMs)) {
        const closesAtSeconds =
          Math.floor((startMs + (session.duration_minutes ?? 60) * 60_000 + 30 * 60_000) / 1000) +
          5 * 60;
        exp = Math.max(exp, closesAtSeconds);
      }
    }

    const token = await new SignJWT({
      aud: "jitsi",
      iss: "chat",
      sub: APP_ID,
      room: roomName,
      context: {
        user: {
          id: user.id,
          name: displayName,
          email: user.email ?? "",
          avatar: "",
          moderator: isTeacher ? "true" : "false",
        },
        features: {
          livestreaming: "false",
          recording: "false",
          transcription: "false",
          "outbound-call": "false",
        },
      },
    })
      .setProtectedHeader({ alg: "RS256", kid: `${APP_ID}/${KEY_ID}`, typ: "JWT" })
      .setIssuedAt(now)
      .setNotBefore(now - 10)
      .setExpirationTime(exp)
      .sign(privateKey);

    return json(200, {
      token,
      roomName,
      domain: "8x8.vc",
      appId: APP_ID,
    });
  } catch (error) {
    return json(500, {
      error: error instanceof Error ? error.message : "Internal error",
    });
  }
});
