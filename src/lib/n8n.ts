import { supabase } from "@/integrations/supabase/client";

// Optional n8n integration for recommendations and credit events.
// Browser code never signs webhook requests directly. It calls the
// authenticated `n8n-webhook` Edge Function, which reads server-side secrets.

export type Recommendation = { message: string; type?: string };

const RECOMMENDATION_TIMEOUT_MS = 2500;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => globalThis.setTimeout(() => resolve(null), ms)),
  ]);
}

export async function getRecommendations(payload: {
  userId: string;
  teachingSkills: string[];
  learningSkills: string[];
}): Promise<Recommendation[]> {
  try {
    const result = await withTimeout(
      supabase.functions.invoke<{ recommendations: Recommendation[] | null }>("n8n-webhook", {
        body: { type: "recommendation", payload },
      }),
      RECOMMENDATION_TIMEOUT_MS,
    );

    const recommendations = result?.data?.recommendations;
    if (Array.isArray(recommendations)) {
      return recommendations;
    }
  } catch {
    // fall through to mock
  }
  return mockRecommendations(payload);
}

function mockRecommendations(p: {
  teachingSkills: string[];
  learningSkills: string[];
}): Recommendation[] {
  const out: Recommendation[] = [];
  if (p.teachingSkills[0]) {
    out.push({
      message: `You added ${p.teachingSkills[0]}. You can now teach 3 students.`,
    });
  }
  if (p.learningSkills[0]) {
    out.push({
      message: `2 students are looking to learn ${p.learningSkills[0]} from you.`,
    });
  }
  if (p.learningSkills.includes("React")) {
    out.push({ message: "To learn React, complete JavaScript basics first." });
  }
  out.push({
    message: "Update your profile bio to get better matches.",
  });
  return out.slice(0, 4);
}

// Optional notification to n8n that a session's credits moved. The actual
// transfer is performed atomically in the `complete_session` RPC — this is
// only a downstream side-effect for analytics or external automation, so
// callers should treat ok=false as informational, not as a transfer failure.
export async function transferCredits(payload: {
  fromUser: string;
  toUser: string;
  amount: number;
  sessionId: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data, error } = await supabase.functions.invoke<{ ok: boolean }>("n8n-webhook", {
      body: { type: "credit-transfer", payload },
    });
    if (error) return { ok: false, error: error.message };
    if (data?.ok) return { ok: true };
    return { ok: false, error: "n8n webhook did not acknowledge" };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "n8n webhook unreachable",
    };
  }
}
