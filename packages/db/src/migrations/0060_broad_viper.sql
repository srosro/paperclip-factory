DROP INDEX "messaging_channels_backend_ref_idx";--> statement-breakpoint
DROP INDEX "messaging_identities_backend_user_idx";--> statement-breakpoint
DROP INDEX "messaging_message_refs_backend_ref_idx";--> statement-breakpoint
DROP INDEX "messaging_threads_channel_idx";--> statement-breakpoint
ALTER TABLE "messaging_channels" ADD COLUMN "workspace_install_id" uuid;--> statement-breakpoint
ALTER TABLE "messaging_identities" ADD COLUMN "workspace_install_id" uuid;--> statement-breakpoint
ALTER TABLE "messaging_channels" ADD CONSTRAINT "messaging_channels_workspace_install_id_messaging_workspace_install_id_fk" FOREIGN KEY ("workspace_install_id") REFERENCES "public"."messaging_workspace_install"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_identities" ADD CONSTRAINT "messaging_identities_workspace_install_id_messaging_workspace_install_id_fk" FOREIGN KEY ("workspace_install_id") REFERENCES "public"."messaging_workspace_install"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_channels_workspace_ref_idx" ON "messaging_channels" USING btree ("workspace_install_id","external_channel_ref") WHERE workspace_install_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_channels_company_ref_idx" ON "messaging_channels" USING btree ("company_id","backend","external_channel_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_identities_workspace_user_idx" ON "messaging_identities" USING btree ("workspace_install_id","external_user_ref") WHERE workspace_install_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_identities_company_backend_user_idx" ON "messaging_identities" USING btree ("company_id","backend","external_user_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_message_refs_thread_ref_idx" ON "messaging_message_refs" USING btree ("thread_id","external_message_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_threads_channel_thread_idx" ON "messaging_threads" USING btree ("channel_id","external_thread_ref");--> statement-breakpoint
-- Backfill workspace_install_id on existing Slack rows from messaging_workspace_install.
-- Forward-only: prior rows had no workspace linkage.
UPDATE "messaging_channels"
SET "workspace_install_id" = wi.id
FROM "messaging_workspace_install" AS wi
WHERE "messaging_channels"."company_id" = wi."company_id"
  AND "messaging_channels"."backend" = wi."backend"
  AND wi."state" = 'active'
  AND "messaging_channels"."backend" = 'slack'
  AND "messaging_channels"."workspace_install_id" IS NULL;--> statement-breakpoint
UPDATE "messaging_identities"
SET "workspace_install_id" = wi.id
FROM "messaging_workspace_install" AS wi
WHERE "messaging_identities"."company_id" = wi."company_id"
  AND "messaging_identities"."backend" = wi."backend"
  AND wi."state" = 'active'
  AND "messaging_identities"."backend" = 'slack'
  AND "messaging_identities"."workspace_install_id" IS NULL;