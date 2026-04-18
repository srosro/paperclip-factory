import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { companySecrets } from "./company_secrets.js";

export const messagingIdentities = pgTable(
  "messaging_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id),
    userId: text("user_id").references(() => authUsers.id),
    backend: text("backend").notNull(),
    externalUserRef: text("external_user_ref").notNull(),
    authBlobSecretId: uuid("auth_blob_secret_id").references(() => companySecrets.id),
    state: text("state").notNull().default("pending_auth"),
    inboxPreferences: jsonb("inbox_preferences").$type<Record<string, unknown>>(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    xorCheck: check(
      "messaging_identities_xor_check",
      sql`(agent_id IS NOT NULL) <> (user_id IS NOT NULL)`,
    ),
    backendUserUnique: uniqueIndex("messaging_identities_backend_user_idx").on(
      table.backend,
      table.externalUserRef,
    ),
    companyAgentUnique: uniqueIndex("messaging_identities_company_agent_idx")
      .on(table.companyId, table.backend, table.agentId)
      .where(sql`agent_id IS NOT NULL`),
    companyUserUnique: uniqueIndex("messaging_identities_company_user_idx")
      .on(table.companyId, table.backend, table.userId)
      .where(sql`user_id IS NOT NULL`),
  }),
);
