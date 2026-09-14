import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

// Only the translator's own tables are managed from this repo. `users` and
// `api_usage_logs` are owned by Navigator; the tablesFilter guarantees a
// `drizzle-kit push` here can never touch them.
export default defineConfig({
  schema: path.join(__dirname, "./src/schema/schema-cworks-translator.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  tablesFilter: ["cworks_translation_*"],
});
