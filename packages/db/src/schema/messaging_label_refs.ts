import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { labels } from "./labels.js";

/**
 * Sync map between Paperclip's `labels` and external-tracker labels
 * (Linear today). One row per (paperclip label, backend) so label
 * changes in either direction resolve to the right counterpart.
 */
export const messagingLabelRefs = pgTable(
  "messaging_label_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    backend: text("backend").notNull(),
    paperclipLabelId: uuid("paperclip_label_id")
      .notNull()
      .references(() => labels.id),
    externalLabelRef: text("external_label_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    labelBackendUnique: uniqueIndex("messaging_label_refs_label_backend_idx").on(
      table.paperclipLabelId,
      table.backend,
    ),
    companyBackendRefUnique: uniqueIndex(
      "messaging_label_refs_company_backend_ref_idx",
    ).on(table.companyId, table.backend, table.externalLabelRef),
  }),
);
