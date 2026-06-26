import { execFile } from "node:child_process";
import { promisify } from "node:util";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const execFileAsync = promisify(execFile);

function redactTelegramToken(value) {
  return String(value || "").replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>");
}

export function telegramIsConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

export async function sendTelegramMessage(text, options = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = options.chatId || process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  }

  return telegramRequest(token, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: options.replyMarkup
  });
}

export async function sendTelegramPhoto(photoPath, options = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = options.chatId || process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  }

  return telegramMultipartRequestWithCurl(token, "sendPhoto", {
    chat_id: chatId,
    caption: options.caption,
    reply_markup: options.replyMarkup ? JSON.stringify(options.replyMarkup) : undefined,
    photo: photoPath
  });
}

export async function sendChatAction(action = "typing", options = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = options.chatId || process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  }

  return telegramRequest(token, "sendChatAction", {
    chat_id: chatId,
    action
  });
}

export async function getTelegramUpdates(options = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  const payload = {};
  if (options.offset != null) payload.offset = options.offset;
  if (options.timeout != null) payload.timeout = options.timeout;

  return telegramRequest(token, "getUpdates", Object.keys(payload).length ? payload : undefined);
}

export async function answerCallbackQuery(callbackQueryId, options = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  return telegramRequest(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: options.text,
    show_alert: options.showAlert
  });
}

async function telegramRequest(token, method, payload) {
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;

  try {
    const response = await fetch(url, {
      method: payload ? "POST" : "GET",
      headers: payload ? { "content-type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined
    });

    const body = await response.text();

    if (!response.ok) {
      throw new Error(`Telegram returned ${response.status}: ${body.slice(0, 300)}`);
    }

    return JSON.parse(body);
  } catch (error) {
    if (error.message?.startsWith("Telegram returned")) throw error;
    return telegramRequestWithCurl(url, payload);
  }
}

async function telegramRequestWithCurl(url, payload) {
  const args = ["-sS"];

  if (payload) {
    args.push(
      "-X",
      "POST",
      "-H",
      "content-type: application/json",
      "--data",
      JSON.stringify(payload)
    );
  }

  args.push(url);

  const { stdout, stderr } = await execCurl(args);

  if (stderr) {
    throw new Error(`curl Telegram request failed: ${redactTelegramToken(stderr).slice(0, 300)}`);
  }

  const parsed = JSON.parse(stdout);
  if (!parsed.ok) {
    throw new Error(`Telegram returned error: ${stdout.slice(0, 300)}`);
  }

  return parsed;
}

async function telegramMultipartRequestWithCurl(token, method, payload) {
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  const args = ["-sS", "-X", "POST"];

  for (const [key, value] of Object.entries(payload)) {
    if (value == null) continue;
    if (key === "photo") {
      args.push("-F", `${key}=@${value}`);
    } else {
      args.push("-F", `${key}=${value}`);
    }
  }

  args.push(url);

  const { stdout, stderr } = await execCurl(args);

  if (stderr) {
    throw new Error(`curl Telegram request failed: ${redactTelegramToken(stderr).slice(0, 300)}`);
  }

  const parsed = JSON.parse(stdout);
  if (!parsed.ok) {
    throw new Error(`Telegram returned error: ${stdout.slice(0, 300)}`);
  }

  return parsed;
}

async function execCurl(args) {
  try {
    return await execFileAsync("curl", args, {
      maxBuffer: 1024 * 1024
    });
  } catch (error) {
    const message = redactTelegramToken(error.stderr || error.message || error);
    throw new Error(`curl Telegram request failed: ${message.slice(0, 300)}`);
  }
}
