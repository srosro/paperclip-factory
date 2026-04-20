# Messaging

Issue-tracker-backed comm layer for Paperclip. Linear is the target real backend (Plan B); FakeAdapter backs tests and local dev. See `docs/superpowers/specs/2026-04-19-linear-backend-migration-design.md`.

## Module rules

- `router.ts` is the only writer to initial inserts on `issue_comment_refs` for outbound posts.
- `events.ts` is the only writer to `issue_comment_refs` edit/delete/reaction timestamps for inbound events.
- Adapters never touch Paperclip's DB directly; they expose issue/comment operations and emit canonical events through `normalizeEvent`.
