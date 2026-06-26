import { loadDotEnv } from "./config.js";
import { getTelegramUpdates, sendTelegramMessage } from "./telegram.js";

await loadDotEnv();

const command = process.argv[2] || "send";

if (command === "updates") {
  const updates = await getTelegramUpdates();
  const chats = updates.result
    .map((update) => update.message?.chat || update.channel_post?.chat)
    .filter(Boolean)
    .map((chat) => ({
      id: chat.id,
      type: chat.type,
      title: chat.title,
      username: chat.username,
      firstName: chat.first_name
    }));

  console.log(JSON.stringify(chats, null, 2));
} else {
  await sendTelegramMessage("Prueba del monitor FIFA Hospitality: Telegram conectado.");
  console.log("Telegram test message sent.");
}
