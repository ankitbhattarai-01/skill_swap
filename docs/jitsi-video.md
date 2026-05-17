# Jitsi Video Integration

SkillSwap creates Jitsi video rooms when a teacher accepts a session.
The app stores the generated Jitsi room URL in the existing `sessions.meet_link`
column for backward compatibility.

## Environment

No account, API key, or credit card is required for the default setup.

By default, SkillSwap uses:

```env
VITE_JITSI_DOMAIN="meet.jit.si"
```

You can omit this variable unless you want to use a self-hosted Jitsi server.

## Flow

1. Learner requests a session.
2. Teacher accepts the session.
3. `createVideoRoom()` generates a unique Jitsi room URL.
4. The URL is saved to `sessions.meet_link`.
5. Both users can join from Dashboard, Sessions, or Session Details.
6. Join opens `/video/:sessionId`, which embeds the Jitsi room inside SkillSwap.

## Notes

- The public `meet.jit.si` service is good for demos, testing, and student projects.
- The in-app video page uses a Jitsi iframe with camera, microphone, fullscreen,
  display-capture, autoplay, and clipboard permissions.
- For production control, branding, or stricter privacy, self-host Jitsi and set
  `VITE_JITSI_DOMAIN` to your domain.
- The database column is still named `meet_link` to avoid a risky migration.
