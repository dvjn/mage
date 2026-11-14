import { pgTable, text } from "drizzle-orm/pg-core";

import { at, NOW } from "@/server/db/columns.ts";

import { space } from "@/server/spaces/schema.ts";
import { user, organization } from "@/server/orgs/schema.ts";

// The instructions an org or one of its spaces gives the agent, by the org's or the space's id.
export const instruction = pgTable("instruction", {
  scopeId: text("scope_id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  // The space they are for; null for the whole org.
  spaceId: text("space_id").references(() => space.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  updatedAt: at("updated_at")
    .default(NOW)
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});
