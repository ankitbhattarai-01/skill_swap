import { supabase } from "@/integrations/supabase/client";

export type JitsiTokenResponse = {
  token: string;
  roomName: string;
  domain: string;
  appId: string;
};

async function readFunctionError(error: unknown) {
  const response = (error as { context?: Response }).context;
  if (response && typeof response.text === "function") {
    try {
      const raw = await response.text();
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { error?: string; message?: string };
      return parsed.error ?? parsed.message ?? raw;
    } catch {
      return null;
    }
  }
  return null;
}

export async function fetchJitsiToken(input: { sessionId: string }): Promise<JitsiTokenResponse> {
  const { data, error } = await supabase.functions.invoke<JitsiTokenResponse>("mint-jitsi-token", {
    body: input,
  });
  if (error) {
    const functionMessage = await readFunctionError(error);
    throw new Error(functionMessage ?? error.message);
  }
  if (!data?.token) throw new Error("No token returned");
  return data;
}
