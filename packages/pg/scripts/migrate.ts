// npm run migrate: applies sql/ migrations to DATABASE_URL.
import { migrate } from "../src/migrate.ts";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
await migrate(url);
