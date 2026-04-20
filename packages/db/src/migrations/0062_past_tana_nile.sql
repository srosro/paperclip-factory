-- Copy rows from the Slack-era messaging_message_refs into issue_comment_refs.
-- Join through messaging_threads to resolve each ref's target issue_id. Any
-- refs whose thread row has been deleted (should not happen in practice) are
-- silently skipped.
INSERT INTO "issue_comment_refs" (
  id, issue_id, backend, external_message_ref,
  author_agent_id, author_user_id, created_by_run_id,
  first_seen_at, edited_at, edit_count, deleted_at,
  suppressed_for_wake, reactions, metadata
)
SELECT
  mmr.id, mt.issue_id, mmr.backend, mmr.external_message_ref,
  mmr.author_agent_id, mmr.author_user_id, mmr.created_by_run_id,
  mmr.first_seen_at, mmr.edited_at, mmr.edit_count, mmr.deleted_at,
  mmr.suppressed_for_wake, mmr.reactions, mmr.metadata
FROM "messaging_message_refs" mmr
JOIN "messaging_threads" mt ON mt.id = mmr.thread_id
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Retarget issue_attachments FK to issue_comment_refs. Safe because the copy
-- above preserved the primary-key id.
ALTER TABLE "issue_attachments" DROP CONSTRAINT "issue_attachments_messaging_message_ref_id_messaging_message_refs_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_messaging_message_ref_id_issue_comment_refs_id_fk" FOREIGN KEY ("messaging_message_ref_id") REFERENCES "public"."issue_comment_refs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messaging_channels" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messaging_message_refs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messaging_threads" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "messaging_channels" CASCADE;--> statement-breakpoint
DROP TABLE "messaging_message_refs" CASCADE;--> statement-breakpoint
DROP TABLE "messaging_threads" CASCADE;
