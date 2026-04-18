import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { authUsers } from "./auth.js";
import { messagingWorkspaceInstall } from "./messaging_workspace_install.js";

export const messagingChannels = pgTable(
  "messaging_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    backend: text("backend").notNull(),
    /**
     * Workspace install that owns this channel. Required for Slack rows so
     * every channel traces unambiguously to one workspace; nullable for the
     * fake adapter (tests/dev).
     */
    workspaceInstallId: uuid("workspace_install_id").references(
      () => messagingWorkspaceInstall.id,
    ),
    purpose: text("purpose").notNull(),  // 'project' | 'inbox' | 'ad_hoc'
    projectId: uuid("project_id").references(() => projects.id),
    userId: text("user_id").references(() => authUsers.id),
    externalChannelRef: text("external_channel_ref").notNull(),
    externalChannelName: text("external_channel_name"),
    state: text("state").notNull().default("active"),
    /**
     * Backend-specific metadata. Used by the inbox service to track per-DM
     * dedup state (last posted event, last posted Slack ts, last issue id,
     * rolled-up summary counts) so events within a 2-minute window update the
     * existing DM message instead of spamming new ones.
     */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Slack identity: (workspace_install_id, external_channel_ref) is the
    // natural key. Partial so fake-adapter rows (workspace_install_id NULL)
    // don't conflict across companies.
    workspaceChannelUnique: uniqueIndex("messaging_channels_workspace_ref_idx")
      .on(table.workspaceInstallId, table.externalChannelRef)
      .where(sql`workspace_install_id IS NOT NULL`),
    // Company-scoped uniqueness for fake rows and as a backstop for Slack.
    companyChannelUnique: uniqueIndex("messaging_channels_company_ref_idx").on(
      table.companyId,
      table.backend,
      table.externalChannelRef,
    ),
    companyProjectUnique: uniqueIndex("messaging_channels_company_project_idx")
      .on(table.companyId, table.backend, table.projectId)
      .where(sql`purpose = 'project'`),
    companyInboxUnique: uniqueIndex("messaging_channels_company_inbox_idx")
      .on(table.companyId, table.backend, table.userId)
      .where(sql`purpose = 'inbox'`),
    purposeCheck: check(
      "messaging_channels_purpose_check",
      sql`(purpose = 'project' AND project_id IS NOT NULL)
          OR (purpose = 'inbox'   AND user_id    IS NOT NULL)
          OR (purpose = 'ad_hoc')`,
    ),
    stateIdx: index("messaging_channels_state_idx").on(table.companyId, table.state),
  }),
);
