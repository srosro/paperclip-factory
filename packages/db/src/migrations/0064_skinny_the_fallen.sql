DROP INDEX "issues_company_status_idx";--> statement-breakpoint
DROP INDEX "issues_company_assignee_status_idx";--> statement-breakpoint
DROP INDEX "issues_company_assignee_user_status_idx";--> statement-breakpoint
DROP INDEX "issues_identifier_idx";--> statement-breakpoint
DROP INDEX "issues_title_search_idx";--> statement-breakpoint
DROP INDEX "issues_identifier_search_idx";--> statement-breakpoint
DROP INDEX "issues_description_search_idx";--> statement-breakpoint
DROP INDEX "issues_open_routine_execution_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "issues_open_routine_execution_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'routine_execution'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."execution_run_id" is not null;--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "title";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "priority";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "issue_number";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "identifier";