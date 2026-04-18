import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";
import { companySecrets } from "./company_secrets.js";

export const messagingWorkspaceInstall = pgTable(
  "messaging_workspace_install",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    backend: text("backend").notNull(),
    externalWorkspaceRef: text("external_workspace_ref").notNull(),
    workspaceName: text("workspace_name"),
    botUserRef: text("bot_user_ref").notNull(),
    botTokenSecretId: uuid("bot_token_secret_id").notNull().references(() => companySecrets.id),
    signingSecretId: uuid("signing_secret_id").notNull().references(() => companySecrets.id),
    installedByUserId: text("installed_by_user_id").references(() => authUsers.id),
    state: text("state").notNull().default("active"),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyBackendIdx: index("messaging_workspace_install_company_backend_idx").on(
      table.companyId,
      table.backend,
    ),
  }),
);
