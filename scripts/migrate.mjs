import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
const sql = neon(connectionString);
for (const filename of (await readdir(migrationsDirectory)).filter((value) => value.endsWith(".sql")).sort()) {
  const migration = await readFile(join(migrationsDirectory, filename), "utf8");
  for (const statement of migration.split(";").map((value) => value.trim()).filter(Boolean)) await sql.query(statement);
  console.log(`Applied ${filename}`);
}
