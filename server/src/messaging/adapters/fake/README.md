# FakeAdapter

In-memory `MessagingAdapter` used by tests and local dev (`activeBackend='fake'`).
`postMessage` synchronously echoes an inbound event to `messaging/events.ts` so wake dispatch exercises the real pipeline.
