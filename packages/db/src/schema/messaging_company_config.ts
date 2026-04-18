import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const messagingCompanyConfig = pgTable(
  "messaging_company_config",
  {
    companyId: uuid("company_id").primaryKey().references(() => companies.id),
    activeBackend: text("active_backend"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
