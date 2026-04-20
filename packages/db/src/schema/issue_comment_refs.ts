import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * Pointer rows for issue comments that live in the external issue tracker
 * (Linear today; GitHub/Jira/etc. in the future). One row per external
 * comment. Body text lives in the external tracker — Paperclip never
 * stores it. The ref row carries orchestration metadata (run linkage,
 * wake suppression, edit/delete timestamps, reactions).
 *
 * Supersedes messaging_message_refs from the Slack-era schema.
 * Changes vs. predecessor:
 *   - FK is issueId -> issues.id (was threadId -> messaging_threads.id)
 *   - Uniqueness is (issueId, externalMessageRef) (was (backend, ...)
 *     then (threadId, ...) after Track 3)
 */
export const issueCommentRefs = pgTable(
  "issue_comment_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id),
    backend: text("backend").notNull(),
    externalMessageRef: text("external_message_ref").notNull(),
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    authorUserId: text("author_user_id").references(() => authUsers.id),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    editCount: integer("edit_count").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    suppressedForWake: boolean("suppressed_for_wake").notNull().default(false),
    reactions: jsonb("reactions").$type<Record<string, string[]>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => ({
    issueRefUnique: uniqueIndex("issue_comment_refs_issue_ref_idx").on(
      table.issueId,
      table.externalMessageRef,
    ),
    issueFirstSeenIdx: index("issue_comment_refs_issue_seen_idx").on(
      table.issueId,
      table.firstSeenAt,
    ),
    runIdx: index("issue_comment_refs_run_idx").on(table.createdByRunId),
  }),
);
