CREATE TABLE "messaging_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"backend" text NOT NULL,
	"purpose" text NOT NULL,
	"project_id" uuid,
	"user_id" text,
	"external_channel_ref" text NOT NULL,
	"external_channel_name" text,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messaging_channels_purpose_check" CHECK ((purpose = 'project' AND project_id IS NOT NULL)
          OR (purpose = 'inbox'   AND user_id    IS NOT NULL)
          OR (purpose = 'ad_hoc'))
);
--> statement-breakpoint
CREATE TABLE "messaging_company_config" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"active_backend" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messaging_events_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backend" text NOT NULL,
	"external_event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messaging_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"user_id" text,
	"backend" text NOT NULL,
	"external_user_ref" text NOT NULL,
	"auth_blob_secret_id" uuid,
	"state" text DEFAULT 'pending_auth' NOT NULL,
	"inbox_preferences" jsonb,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messaging_identities_xor_check" CHECK ((agent_id IS NOT NULL) <> (user_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "messaging_message_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"backend" text NOT NULL,
	"external_message_ref" text NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"created_by_run_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"edit_count" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"suppressed_for_wake" boolean DEFAULT false NOT NULL,
	"reactions" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "messaging_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"backend" text NOT NULL,
	"external_thread_ref" text NOT NULL,
	"parent_message_ref" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messaging_workspace_install" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"backend" text NOT NULL,
	"external_workspace_ref" text NOT NULL,
	"workspace_name" text,
	"bot_user_ref" text NOT NULL,
	"bot_token_secret_id" uuid NOT NULL,
	"signing_secret_id" uuid NOT NULL,
	"installed_by_user_id" text,
	"state" text DEFAULT 'active' NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_comments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "issue_comments" CASCADE;--> statement-breakpoint
ALTER TABLE "issue_attachments" DROP CONSTRAINT IF EXISTS "issue_attachments_issue_comment_id_issue_comments_id_fk";
--> statement-breakpoint
DROP INDEX "issue_attachments_issue_comment_idx";--> statement-breakpoint
ALTER TABLE "issue_attachments" ADD COLUMN "messaging_message_ref_id" uuid;--> statement-breakpoint
ALTER TABLE "messaging_channels" ADD CONSTRAINT "messaging_channels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_channels" ADD CONSTRAINT "messaging_channels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_channels" ADD CONSTRAINT "messaging_channels_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_company_config" ADD CONSTRAINT "messaging_company_config_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_identities" ADD CONSTRAINT "messaging_identities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_identities" ADD CONSTRAINT "messaging_identities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_identities" ADD CONSTRAINT "messaging_identities_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_identities" ADD CONSTRAINT "messaging_identities_auth_blob_secret_id_company_secrets_id_fk" FOREIGN KEY ("auth_blob_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_message_refs" ADD CONSTRAINT "messaging_message_refs_thread_id_messaging_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."messaging_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_message_refs" ADD CONSTRAINT "messaging_message_refs_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_message_refs" ADD CONSTRAINT "messaging_message_refs_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_message_refs" ADD CONSTRAINT "messaging_message_refs_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_threads" ADD CONSTRAINT "messaging_threads_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_threads" ADD CONSTRAINT "messaging_threads_channel_id_messaging_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."messaging_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_workspace_install" ADD CONSTRAINT "messaging_workspace_install_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_workspace_install" ADD CONSTRAINT "messaging_workspace_install_bot_token_secret_id_company_secrets_id_fk" FOREIGN KEY ("bot_token_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_workspace_install" ADD CONSTRAINT "messaging_workspace_install_signing_secret_id_company_secrets_id_fk" FOREIGN KEY ("signing_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_workspace_install" ADD CONSTRAINT "messaging_workspace_install_installed_by_user_id_user_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_channels_backend_ref_idx" ON "messaging_channels" USING btree ("backend","external_channel_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_channels_company_project_idx" ON "messaging_channels" USING btree ("company_id","backend","project_id") WHERE purpose = 'project';--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_channels_company_inbox_idx" ON "messaging_channels" USING btree ("company_id","backend","user_id") WHERE purpose = 'inbox';--> statement-breakpoint
CREATE INDEX "messaging_channels_state_idx" ON "messaging_channels" USING btree ("company_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_events_inbox_backend_event_idx" ON "messaging_events_inbox" USING btree ("backend","external_event_id");--> statement-breakpoint
CREATE INDEX "messaging_events_inbox_received_idx" ON "messaging_events_inbox" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_identities_backend_user_idx" ON "messaging_identities" USING btree ("backend","external_user_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_identities_company_agent_idx" ON "messaging_identities" USING btree ("company_id","backend","agent_id") WHERE agent_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_identities_company_user_idx" ON "messaging_identities" USING btree ("company_id","backend","user_id") WHERE user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_message_refs_backend_ref_idx" ON "messaging_message_refs" USING btree ("backend","external_message_ref");--> statement-breakpoint
CREATE INDEX "messaging_message_refs_thread_seen_idx" ON "messaging_message_refs" USING btree ("thread_id","first_seen_at");--> statement-breakpoint
CREATE INDEX "messaging_message_refs_run_idx" ON "messaging_message_refs" USING btree ("created_by_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_threads_issue_idx" ON "messaging_threads" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "messaging_threads_channel_idx" ON "messaging_threads" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "messaging_workspace_install_company_backend_idx" ON "messaging_workspace_install" USING btree ("company_id","backend");--> statement-breakpoint
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_messaging_message_ref_id_messaging_message_refs_id_fk" FOREIGN KEY ("messaging_message_ref_id") REFERENCES "public"."messaging_message_refs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_attachments_messaging_message_ref_idx" ON "issue_attachments" USING btree ("messaging_message_ref_id");--> statement-breakpoint
ALTER TABLE "issue_attachments" DROP COLUMN "issue_comment_id";