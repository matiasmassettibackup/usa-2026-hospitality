import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import pg from "pg";

const { Pool } = pg;
const SUBSCRIPTIONS_FILE = ".state/subscriptions.json";
const AVAILABILITY_EVENTS_FILE = ".state/availability-events.csv";

let pool;

export function stateBackend() {
  return String(process.env.STATE_BACKEND || "file").toLowerCase();
}

export function usePostgresState() {
  return stateBackend() === "postgres";
}

export function stateDir() {
  return process.env.BOT_STATE_DIR || process.env.STATE_DIR || ".state";
}

export function statePath(path) {
  if (isAbsolute(path)) return path;
  if (path.startsWith(".state/")) return join(stateDir(), path.slice(".state/".length));
  return path;
}

function databaseUrl() {
  return process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
}

function db() {
  if (!usePostgresState()) return null;
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error("STATE_BACKEND=postgres requires DATABASE_URL or SUPABASE_DB_URL");
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
    });
    pool.on("error", (error) => {
      console.error(`[${new Date().toISOString()}] Postgres pool error: ${error.message}`);
    });
  }

  return pool;
}

function stateKey(path) {
  if (path.startsWith(".state/")) return path.slice(".state/".length);
  return path;
}

async function readFileState(path) {
  try {
    return JSON.parse(await readFile(statePath(path), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      if (path === SUBSCRIPTIONS_FILE && process.env.BOOTSTRAP_SUBSCRIPTIONS_JSON) {
        return JSON.parse(process.env.BOOTSTRAP_SUBSCRIPTIONS_JSON);
      }
      return {};
    }
    throw error;
  }
}

async function writeFileState(path, state) {
  const targetPath = statePath(path);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(state, null, 2)}\n`);
}

function userFromChat(chatId, chatState = {}) {
  const user = chatState.user || {};
  return {
    chatId: String(chatId),
    username: user.username || null,
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    chatTitle: user.chatTitle || null,
    chatType: user.chatType || null,
    priority: Number(user.priority ?? chatState.priority ?? 0) || 0,
    firstSeenAt: user.firstSeenAt || null,
    lastSeenAt: user.lastSeenAt || null,
    rawUser: user
  };
}

function userDisplayName(user) {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  if (fullName) return fullName;
  if (user.username) return `@${user.username}`;
  if (user.chatTitle) return user.chatTitle;
  return user.chatId;
}

function subscriptionColumns(chatId, chatState, subscription) {
  const user = userFromChat(chatId, chatState);
  return {
    chatId: String(chatId),
    userDisplayName: userDisplayName(user),
    match: subscription.match,
    section: subscription.section || null,
    sectionCode: subscription.sectionCode || null,
    cheapestPerCategory: Boolean(subscription.cheapestPerCategory),
    allSections: Boolean(subscription.allSections),
    subscription
  };
}

async function readSubscriptionsState() {
  const client = await db().connect();
  try {
    const users = await client.query("select * from public.telegram_users order by chat_id");
    const subscriptions = await client.query("select * from public.subscriptions order by id");
    const state = { chats: {} };

    for (const row of users.rows) {
      state.chats[row.chat_id] = {
        priority: row.priority,
        user: {
          ...(row.raw_user || {}),
          chatId: row.chat_id,
          username: row.username || undefined,
          firstName: row.first_name || undefined,
          lastName: row.last_name || undefined,
          chatTitle: row.chat_title || undefined,
          chatType: row.chat_type || undefined,
          priority: row.priority,
          firstSeenAt: row.first_seen_at?.toISOString?.() || row.first_seen_at || undefined,
          lastSeenAt: row.last_seen_at?.toISOString?.() || row.last_seen_at || undefined
        },
        subscriptions: []
      };
    }

    for (const row of subscriptions.rows) {
      state.chats[row.chat_id] ||= {
        priority: 0,
        user: { chatId: row.chat_id, priority: 0 },
        subscriptions: []
      };
      state.chats[row.chat_id].subscriptions.push(row.subscription);
    }

    return state;
  } finally {
    client.release();
  }
}

async function writeSubscriptionsState(state) {
  const client = await db().connect();
  try {
    await client.query("begin");

    for (const [chatId, chatState] of Object.entries(state.chats || {})) {
      const user = userFromChat(chatId, chatState);
      await client.query(
        `insert into public.telegram_users (
          chat_id, username, first_name, last_name, chat_title, chat_type,
          priority, first_seen_at, last_seen_at, raw_user
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        on conflict (chat_id) do update set
          username = excluded.username,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          chat_title = excluded.chat_title,
          chat_type = excluded.chat_type,
          priority = excluded.priority,
          first_seen_at = coalesce(public.telegram_users.first_seen_at, excluded.first_seen_at),
          last_seen_at = excluded.last_seen_at,
          raw_user = excluded.raw_user`,
        [
          user.chatId,
          user.username,
          user.firstName,
          user.lastName,
          user.chatTitle,
          user.chatType,
          user.priority,
          user.firstSeenAt,
          user.lastSeenAt,
          user.rawUser
        ]
      );

      await client.query("delete from public.subscriptions where chat_id = $1", [String(chatId)]);
      for (const subscription of chatState.subscriptions || []) {
        const row = subscriptionColumns(chatId, chatState, subscription);
        await client.query(
          `insert into public.subscriptions (
            chat_id, user_display_name, match, section, section_code,
            cheapest_per_category, all_sections, subscription
          ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            row.chatId,
            row.userDisplayName,
            row.match,
            row.section,
            row.sectionCode,
            row.cheapestPerCategory,
            row.allSections,
            row.subscription
          ]
        );
      }
    }

    await client.query(
      `insert into public.bot_state (key, value)
       values ($1, $2)
       on conflict (key) do update set value = excluded.value`,
      [stateKey(SUBSCRIPTIONS_FILE), state]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function readState(path) {
  if (!usePostgresState()) return readFileState(path);
  if (path === SUBSCRIPTIONS_FILE) return readSubscriptionsState();

  const result = await db().query("select value from public.bot_state where key = $1", [stateKey(path)]);
  return result.rows[0]?.value || {};
}

export async function writeState(path, state) {
  if (!usePostgresState()) return writeFileState(path, state);
  if (path === SUBSCRIPTIONS_FILE) return writeSubscriptionsState(state);

  await db().query(
    `insert into public.bot_state (key, value)
     values ($1, $2)
     on conflict (key) do update set value = excluded.value`,
    [stateKey(path), state]
  );
}

function csvCell(value) {
  if (value == null) return "";
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

export async function appendCsvRows(path, headers, rows) {
  if (!rows.length) return;

  if (usePostgresState() && path === AVAILABILITY_EVENTS_FILE) {
    for (const row of rows) {
      await db().query(
        `insert into public.availability_events (
          timestamp, match, teams, venue, city, date, section_code, section_name,
          lounge_title, price_usd, available_quantity, can_create_cart
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          row.timestamp,
          row.match,
          row.teams,
          row.venue,
          row.city,
          row.date,
          row.sectionCode,
          row.sectionName,
          row.loungeTitle,
          row.priceUsd,
          row.availableQuantity,
          row.canCreateCart
        ]
      );
    }
    return;
  }

  const targetPath = statePath(path);
  let needsHeader = false;
  try {
    await access(targetPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    needsHeader = true;
  }

  await mkdir(dirname(targetPath), { recursive: true });
  const lines = [
    ...(needsHeader ? [headers.join(",")] : []),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
  ];
  await appendFile(targetPath, `${lines.join("\n")}\n`);
}

export async function closeStateStore() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
