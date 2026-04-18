import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

export const messagingEventsInbox = pgTable(
  "messaging_events_inbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    backend: text("backend").notNull(),
    externalEventId: text("external_event_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => ({
    backendEventUnique: uniqueIndex("messaging_events_inbox_backend_event_idx").on(
      table.backend,
      table.externalEventId,
    ),
    receivedIdx: index("messaging_events_inbox_received_idx").on(table.receivedAt),
  }),
);
