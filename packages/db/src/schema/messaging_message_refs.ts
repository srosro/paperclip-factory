import { pgTable, uuid, text, timestamp, jsonb, integer, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { messagingThreads } from "./messaging_threads.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const messagingMessageRefs = pgTable(
  "messaging_message_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id").notNull().references(() => messagingThreads.id),
    backend: text("backend").notNull(),
    externalMessageRef: text("external_message_ref").notNull(),
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    authorUserId: text("author_user_id").references(() => authUsers.id),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    editCount: integer("edit_count").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    suppressedForWake: boolean("suppressed_for_wake").notNull().default(false),
    reactions: jsonb("reactions").$type<Record<string, string[]>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => ({
    // Slack addresses a message by channel+ts. Since every thread lives in
    // exactly one channel, (thread_id, external_message_ref) is the correct
    // natural key: a given ts is unique inside a thread's channel. This
    // replaces the old (backend, external_message_ref) which allowed two
    // channels sharing a ts to collide onto one row.
    threadRefUnique: uniqueIndex("messaging_message_refs_thread_ref_idx").on(
      table.threadId,
      table.externalMessageRef,
    ),
    threadFirstSeenIdx: index("messaging_message_refs_thread_seen_idx").on(
      table.threadId,
      table.firstSeenAt,
    ),
    runIdx: index("messaging_message_refs_run_idx").on(table.createdByRunId),
  }),
);
