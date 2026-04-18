# Messaging

Backend-agnostic comm layer for Paperclip. Slack is the built-in adapter; FakeAdapter backs tests and local dev. See `docs/superpowers/specs/2026-04-17-slack-first-comms-design.md`.

## Module rules

- `router.ts` is the only writer to `messaging_threads` and initial inserts to `messaging_message_refs`.
- `events.ts` is the only writer to `messaging_message_refs` edit/delete/reaction timestamps.
- Adapters never touch Paperclip's DB directly; they expose canonical operations and events.
