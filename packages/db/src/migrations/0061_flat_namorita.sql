CREATE TABLE "issue_comment_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
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
CREATE TABLE "messaging_label_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"backend" text NOT NULL,
	"paperclip_label_id" uuid NOT NULL,
	"external_label_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "linear_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "linear_issue_identifier" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "linear_project_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_comment_refs" ADD CONSTRAINT "issue_comment_refs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_refs" ADD CONSTRAINT "issue_comment_refs_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_refs" ADD CONSTRAINT "issue_comment_refs_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_refs" ADD CONSTRAINT "issue_comment_refs_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_label_refs" ADD CONSTRAINT "messaging_label_refs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_label_refs" ADD CONSTRAINT "messaging_label_refs_paperclip_label_id_labels_id_fk" FOREIGN KEY ("paperclip_label_id") REFERENCES "public"."labels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_comment_refs_issue_ref_idx" ON "issue_comment_refs" USING btree ("issue_id","external_message_ref");--> statement-breakpoint
CREATE INDEX "issue_comment_refs_issue_seen_idx" ON "issue_comment_refs" USING btree ("issue_id","first_seen_at");--> statement-breakpoint
CREATE INDEX "issue_comment_refs_run_idx" ON "issue_comment_refs" USING btree ("created_by_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_label_refs_label_backend_idx" ON "messaging_label_refs" USING btree ("paperclip_label_id","backend");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_label_refs_company_backend_ref_idx" ON "messaging_label_refs" USING btree ("company_id","backend","external_label_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_linear_issue_id_idx" ON "issues" USING btree ("linear_issue_id") WHERE linear_issue_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_linear_project_id_idx" ON "projects" USING btree ("linear_project_id") WHERE linear_project_id IS NOT NULL;