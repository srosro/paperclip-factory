import { pgTable, uuid, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { assets } from "./assets.js";
import { messagingMessageRefs } from "./messaging_message_refs.js";

export const issueAttachments = pgTable(
  "issue_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    messagingMessageRefId: uuid("messaging_message_ref_id").references(
      () => messagingMessageRefs.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("issue_attachments_company_issue_idx").on(table.companyId, table.issueId),
    messagingMessageRefIdx: index("issue_attachments_messaging_message_ref_idx").on(table.messagingMessageRefId),
    assetUq: uniqueIndex("issue_attachments_asset_uq").on(table.assetId),
  }),
);
