// Shared tables the Drawing Translator reads from the Cworks Postgres database.
//
// These definitions are deliberately partial. The translator only reads a few
// columns from `users` (to label reviewers/operators) and writes cost rows to
// `api_usage_logs`. The full table definitions are owned by Navigator; never
// run `drizzle-kit push` against these two tables from this repo.
import { pgTable, text, varchar, integer, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  email: varchar("email", { length: 320 }),
  displayName: varchar("display_name", { length: 200 }),
  // Enums in Navigator's schema; read here as plain text.
  role: text("role").notNull(),
  status: text("status").notNull(),
});

export type User = typeof users.$inferSelect;

export const apiUsageLogs = pgTable("api_usage_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  service: text("service").notNull(),
  model: text("model"),
  endpoint: text("endpoint"),
  projectId: varchar("project_id"),
  inputTokens: integer("input_tokens").default(0),
  outputTokens: integer("output_tokens").default(0),
  totalTokens: integer("total_tokens").default(0),
  estimatedCost: text("estimated_cost").default("0"),
  prompt: text("prompt"),
  response: text("response"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
