import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";
import { messagingChannels } from "./messaging_channels.js";

export const messagingThreads = pgTable(
  "messaging_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    channelId: uuid("channel_id").notNull().references(() => messagingChannels.id),
    backend: text("backend").notNull(),
    externalThreadRef: text("external_thread_ref").notNull(),
    parentMessageRef: text("parent_message_ref").notNull(),
    state: text("state").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueUnique: uniqueIndex("messaging_threads_issue_idx").on(table.issueId),
    // Channel-aware natural key: Slack thread_ts is unique within a channel.
    channelThreadUnique: uniqueIndex("messaging_threads_channel_thread_idx").on(
      table.channelId,
      table.externalThreadRef,
    ),
  }),
);
