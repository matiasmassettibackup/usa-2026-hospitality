import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadDotEnv } from "../src/config.js";
import { closeStateStore, writeState } from "../src/stateStore.js";

const STATE_FILES = [
  "subscriptions.json",
  "hospitality-monitor.json",
  "telegram-bot.json"
];

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

await loadDotEnv();

if (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL) {
  throw new Error("Set DATABASE_URL or SUPABASE_DB_URL before running the migration");
}

process.env.STATE_BACKEND = "postgres";

const sourceDir = resolve(process.env.STATE_SOURCE_DIR || process.env.BOT_STATE_DIR || ".state");

for (const file of STATE_FILES) {
  const value = await readJson(join(sourceDir, file));
  await writeState(`.state/${file}`, value);
  console.log(`Migrated ${file}`);
}

await closeStateStore();
console.log("Done");
