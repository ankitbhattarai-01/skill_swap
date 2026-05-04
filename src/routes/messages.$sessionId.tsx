import { createFileRoute, redirect } from "@tanstack/react-router";

// Legacy route. The DB trigger `notify_session_message` writes notification
// links of the form `/messages/<session_id>`, and older external links may
// still target this path. The primary chat UI lives at `/messages?s=<id>`,
// which has client-side message-safety filtering, mobile viewport handling,
// and the inbox split-pane. Redirect here so the canonical UI is the only
// one we maintain.
export const Route = createFileRoute("/messages/$sessionId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/messages",
      search: { s: params.sessionId },
      replace: true,
    });
  },
});
