import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadDotEnv } from "./config.js";
import {
  fetchSingleMatchLounges,
  fetchSingleMatchInventory,
  filterMatches,
  getHospitalityOptions,
  summarizeMatch
} from "./fifaHospitality.js";
import {
  answerCallbackQuery,
  getTelegramUpdates,
  sendChatAction,
  sendTelegramMessage,
  sendTelegramPhoto,
  telegramIsConfigured
} from "./telegram.js";

const DEFAULT_STATE_FILE = ".state/hospitality-monitor.json";
const TELEGRAM_BOT_STATE_FILE = ".state/telegram-bot.json";
const SUBSCRIPTIONS_FILE = ".state/subscriptions.json";
const DEFAULT_SECTION = "Suite Essentials";
const DEFAULT_MATCHES = "M70,M86";
const COMMAND_POLL_INTERVAL_SECONDS = 1;
const START_IMAGE_CANDIDATES = [
  "assets/la-banda-argentina.png",
  "assets/la-banda-argentina.jpg",
  "/Users/matiasmassetti/Downloads/la-banda-argentina.png",
  "/Users/matiasmassetti/Downloads/la-banda-argentina.jpg"
];

const DEFAULT_SUBSCRIPTIONS = [
  { match: "M70", section: DEFAULT_SECTION, allSections: false },
  { match: "M86", section: DEFAULT_SECTION, allSections: false }
];

const SECTION_ALIASES = new Map([
  ["all", { allSections: true }],
  ["todo", { allSections: true }],
  ["todos", { allSections: true }],
  ["any", { allSections: true }],
  ["suite", { section: "Suite Essentials" }],
  ["suite essentials", { section: "Suite Essentials" }],
  ["essentials", { section: "Suite Essentials" }],
  ["mel", { sectionCode: "MEL", section: "Suite Essentials" }],
  ["vip", { section: "VIP" }],
  ["pitchside", { section: "Pitchside" }],
  ["pitchside lounge", { section: "Pitchside" }],
  ["trophy", { section: "Trophy" }],
  ["trophy lounge", { section: "Trophy" }],
  ["champions", { section: "Champions" }],
  ["champions club", { section: "Champions" }],
  ["fifa", { section: "FIFA Pavilion" }],
  ["fifa pavilion", { section: "FIFA Pavilion" }],
  ["supporters", { section: "Supporters" }],
  ["supporters club", { section: "Supporters" }]
]);

function parseArgs(argv) {
  const options = {
    interval: 60,
    once: false,
    match: undefined,
    venue: undefined,
    team: undefined,
    section: DEFAULT_SECTION,
    sectionCode: undefined,
    allSections: false,
    stateFile: DEFAULT_STATE_FILE
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--once") options.once = true;
    else if (arg === "--match") options.match = next, index += 1;
    else if (arg === "--venue") options.venue = next, index += 1;
    else if (arg === "--team") options.team = next, index += 1;
    else if (arg === "--section") options.section = next, index += 1;
    else if (arg === "--section-code") options.sectionCode = next, index += 1;
    else if (arg === "--all-sections") options.allSections = true;
    else if (arg === "--interval") options.interval = Number(next), index += 1;
    else if (arg === "--state") options.stateFile = next, index += 1;
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(options.interval) || options.interval < 5) {
    throw new Error("--interval must be a number >= 5 seconds");
  }

  if (!options.match && !options.venue && !options.team) {
    options.match = DEFAULT_MATCHES;
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node src/monitor.js --once --match M70
  node src/monitor.js --once --match M70,M86
  node src/monitor.js --match M70 --interval 60
  node src/monitor.js --once --venue NN_DAL
  node src/monitor.js --once --team Argentina
  node src/monitor.js --once --match M70 --all-sections

Options:
  --match M70,M86              Match number(s) to watch. Defaults to M70,M86.
  --venue NN_DAL               Optional venue filter.
  --team Argentina             Optional team name filter.
  --section "Suite Essentials" Seating section to watch. Defaults to Suite Essentials.
  --section-code MEL           Seating section code to watch.
  --all-sections               Watch any hospitality section instead of Suite Essentials.
  --interval 60                Polling interval in seconds. Defaults to 60.
  --once                       Run one check and exit.
  --state PATH                 State file used to detect unavailable -> available changes.
`);
}

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function writeSubscriptionsState(nextState) {
  const currentState = await readState(SUBSCRIPTIONS_FILE);
  const mergedState = {
    ...nextState,
    chats: { ...(nextState.chats || {}) }
  };

  for (const [chatId, currentChat] of Object.entries(currentState.chats || {})) {
    const nextChat = mergedState.chats[chatId];
    if (!nextChat) {
      mergedState.chats[chatId] = currentChat;
      continue;
    }

    if (currentChat.user && !nextChat.user) {
      mergedState.chats[chatId] = {
        ...nextChat,
        user: currentChat.user
      };
    }
  }

  await writeState(SUBSCRIPTIONS_FILE, mergedState);
}

function formatMoney(amount) {
  if (amount == null) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(amount);
}

function normalizeMatchInput(value) {
  if (!value) return undefined;
  const raw = String(value).trim().toUpperCase();
  const number = raw.startsWith("M") ? Number(raw.slice(1)) : Number(raw);
  if (!Number.isFinite(number)) return undefined;
  return `M${number}`;
}

function normalizeSectionInput(value) {
  const raw = (value || DEFAULT_SECTION).trim();
  const alias = SECTION_ALIASES.get(raw.toLowerCase());
  if (alias) return { ...alias };
  return { section: raw, allSections: false };
}

function subscriptionKey(subscription) {
  const scope = subscription.allSections
    ? "all"
    : subscription.sectionCode || subscription.section || DEFAULT_SECTION;
  return `${subscription.match}:${scope}`;
}

function formatSubscription(subscription) {
  const scope = subscription.allSections
    ? "todas las categorías"
    : subscription.section || subscription.sectionCode || DEFAULT_SECTION;
  return `${subscription.match} - ${scope}`;
}

function defaultSubscriptionState() {
  return {
    chats: {}
  };
}

function normalizeSubscriptionState(state) {
  const normalized = state?.chats ? state : defaultSubscriptionState();

  if (process.env.TELEGRAM_CHAT_ID && !normalized.chats[String(process.env.TELEGRAM_CHAT_ID)]) {
    setChatSubscriptions(normalized, process.env.TELEGRAM_CHAT_ID, DEFAULT_SUBSCRIPTIONS);
  }

  return normalized;
}

function getChatSubscriptions(subscriptionsState, chatId) {
  const key = String(chatId);
  const chatState = subscriptionsState.chats?.[key];
  if (chatState?.subscriptions?.length) return chatState.subscriptions;
  return DEFAULT_SUBSCRIPTIONS;
}

function setChatSubscriptions(subscriptionsState, chatId, subscriptions) {
  const key = String(chatId);
  subscriptionsState.chats = subscriptionsState.chats || {};
  const current = subscriptionsState.chats[key] || {};
  subscriptionsState.chats[key] = {
    ...current,
    subscriptions
  };
}

function rememberChat(subscriptionsState, chatId, chat = {}, from = {}) {
  const key = String(chatId);
  subscriptionsState.chats = subscriptionsState.chats || {};
  const current = subscriptionsState.chats[key] || {};
  const user = {
    ...(current.user || {}),
    chatId: key,
    chatType: chat.type,
    chatTitle: chat.title,
    username: from.username || chat.username || current.user?.username,
    firstName: from.first_name || chat.first_name || current.user?.firstName,
    lastName: from.last_name || chat.last_name || current.user?.lastName,
    languageCode: from.language_code || current.user?.languageCode,
    firstSeenAt: current.user?.firstSeenAt || new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };

  subscriptionsState.chats[key] = {
    ...current,
    user
  };
}

function setPendingAction(botState, chatId, pendingAction) {
  botState.pending = botState.pending || {};
  botState.pending[String(chatId)] = pendingAction;
}

function popPendingAction(botState, chatId) {
  const key = String(chatId);
  const pendingAction = botState.pending?.[key];
  if (pendingAction) delete botState.pending[key];
  return pendingAction;
}

function parseWatchCommand(text) {
  const parts = text.trim().split(/\s+/);
  const match = normalizeMatchInput(parts[1]);
  if (!match) return undefined;

  const sectionText = parts.slice(2).join(" ").trim() || DEFAULT_SECTION;
  const section = normalizeSectionInput(sectionText);
  return {
    match,
    ...section
  };
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Mis alertas", callback_data: "lista" },
        { text: "Estado", callback_data: "estado" }
      ],
      [
        { text: "Precios M70", callback_data: "precios:M70" },
        { text: "Precios M86", callback_data: "precios:M86" }
      ],
      [
        { text: "Seguir M70 Suite Essentials", callback_data: "seguir:M70:suite" },
        { text: "Seguir M70 todas", callback_data: "seguir:M70:all" }
      ],
      [
        { text: "Seguir M86 Suite Essentials", callback_data: "seguir:M86:suite" },
        { text: "Seguir M86 todas", callback_data: "seguir:M86:all" }
      ],
      [
        { text: "Otro partido Suite", callback_data: "otro:suite" },
        { text: "Otro partido todas", callback_data: "otro:all" }
      ],
      [
        { text: "Precios otro partido", callback_data: "precios_otro" }
      ],
      [
        { text: "Ayuda", callback_data: "ayuda" },
        { text: "Menu", callback_data: "menu" }
      ],
      [
        { text: "Reiniciar alertas", callback_data: "reiniciar" }
      ]
    ]
  };
}

function subscriptionsMessage(subscriptions) {
  return formatSubscriptionsBlock(subscriptions).join("\n");
}

function menuMessage() {
  return [
    "Menu principal",
    "",
    "Elegí una opción para ver precios, revisar tus alertas o agregar nuevos partidos."
  ].join("\n");
}

function addSubscription(subscriptionsState, chatId, subscription) {
  const current = getChatSubscriptions(subscriptionsState, chatId);
  const withoutDuplicate = current.filter((item) => subscriptionKey(item) !== subscriptionKey(subscription));
  setChatSubscriptions(subscriptionsState, chatId, [...withoutDuplicate, subscription]);
}

function subscriptionFromCallbackData(data) {
  const [, matchInput, sectionInput] = data.split(":");
  const match = normalizeMatchInput(matchInput);
  if (!match) return undefined;

  return {
    match,
    ...normalizeSectionInput(sectionInput || DEFAULT_SECTION)
  };
}

function isValidMatchNumber(match) {
  const number = Number(String(match || "").replace(/^M/i, ""));
  return Number.isInteger(number) && number >= 1 && number <= 104;
}

async function safelyAnswerCallbackQuery(callbackId, options = {}) {
  try {
    await answerCallbackQuery(callbackId, options);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Ignored old Telegram callback: ${error.message}`);
  }
}

async function safelySendChatAction(chatId, action = "typing") {
  try {
    await sendChatAction(action, { chatId });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Telegram chat action failed: ${error.message}`);
  }
}

function callbackAnswerText(data) {
  if (data === "estado") return "Calculando estado...";
  if (data === "precios_otro" || data.startsWith("precios:")) return "Buscando precios...";
  if (data === "menu" || data === "ayuda" || data === "lista") return undefined;
  return "Listo";
}

function formatSummary(summary) {
  const status = summary.isAvailable ? "AVAILABLE" : summary.isOffered ? "unavailable" : "not offered";
  const price = formatMoney(summary.minAvailablePrice ?? summary.cheapestSelectedPrice);
  const section = summary.selectedSection ? ` (${summary.selectedSection})` : "";
  const anyMatchAvailability = summary.matchHasAnyAvailability && !summary.isAvailable
    ? " | other sections available"
    : "";
  const priceText = summary.isOffered ? ` | from ${price}${section}` : "";
  return `${summary.match} ${summary.teams} | ${summary.venueCode} | ${status}${priceText}${anyMatchAvailability}`;
}

function matchUrl(summary) {
  return `https://fifaworldcup26.hospitality.fifa.com/us/en/choose-matches?venue=${summary.venueCode}`;
}

function matchUrlKeyboard(summary) {
  return {
    inline_keyboard: [
      [
        { text: "Abrir FIFA Hospitality", url: matchUrl(summary) }
      ],
      [
        { text: "Mis alertas", callback_data: "lista" },
        { text: "Estado", callback_data: "estado" }
      ]
    ]
  };
}

function formatTelegramAlert(summary) {
  const price = formatMoney(summary.minAvailablePrice ?? summary.cheapestSelectedPrice);
  const section = summary.selectedSection || summary.cheapestLounge || "Hospitality";

  return [
    "Alerta FIFA Hospitality",
    "",
    `${summary.match} - ${summary.teams}`,
    `${section}: DISPONIBLE desde ${price}`,
    `${summary.venue || summary.venueCode}${summary.city ? `, ${summary.city}` : ""}`,
    `${summary.date} ${summary.dayTime}`,
    "",
    "Usá el botón de abajo para abrir FIFA."
  ].join("\n");
}

function formatTelegramAlertForSubscription(summary, subscription) {
  const price = formatMoney(summary.minAvailablePrice ?? summary.cheapestSelectedPrice);
  const section = summary.selectedSection || summary.cheapestLounge || subscription.section || "Hospitality";

  return [
    "Alerta FIFA Hospitality",
    "",
    `${summary.match} - ${summary.teams}`,
    `${section}: DISPONIBLE desde ${price}`,
    `${summary.venue || summary.venueCode}${summary.city ? `, ${summary.city}` : ""}`,
    `${summary.date} ${summary.dayTime}`,
    "",
    "Usá el botón de abajo para abrir FIFA."
  ].join("\n");
}

function baseWelcomeLines() {
  return [
    "Hola! Soy el bot de Hospitality 2026.",
    "Creado por Matias Massetti.",
    "",
    "Por defecto ya estoy mirando M70 Jordania vs Argentina y M86 Argentina vs 2H en la categoría más barata de hospitality: Suite Essentials.",
    "Precio aprox. de referencia: M70 desde USD 1,350. En M86 Suite Essentials no aparece ofrecida ahora; cuando exista o se libere, te aviso.",
    "",
    "Si aparece disponibilidad, te mando una alerta con partido, sede, precio y link.",
    "",
    "Aviso: este bot no es oficial de FIFA. Solo avisa disponibilidad; no reserva ni compra entradas.",
    "",
    "Chequeo cada 60 segundos.",
    "",
    "Usá los botones para cambiar alertas, ver precios o seguir otros partidos.",
    "",
    "Los precios son valores 'desde' y pueden cambiar. Tocá Precios M70 o Precios M86 para verlos actualizados."
  ];
}

function formatLoungePriceLine(lounge) {
  const sections = lounge.seatingSections || [];
  const prices = sections
    .map((section) => Number(section.StartingPrice))
    .filter((price) => Number.isFinite(price))
    .sort((a, b) => a - b);

  if (!prices.length) return undefined;

  const availableSections = sections
    .filter((section) => section.IsAvailable === true && Number(section.AvailableQuantity || 0) > 0)
    .map((section) => `${section.Name} qty ${section.AvailableQuantity}`);

  const availability = availableSections.length
    ? `disponible: ${availableSections.join(", ")}`
    : "sin disponibilidad ahora";

  return `  - ${lounge.title}: desde ${formatMoney(prices[0])} (${availability})`;
}

function formatSubscriptionsBlock(subscriptions) {
  return [
    "Tus alertas:",
    ...subscriptions.map((subscription) => `- ${formatSubscription(subscription)}`)
  ];
}

async function buildWelcomeMessage(chatId, subscriptionsState) {
  const lines = baseWelcomeLines();

  lines.push("");
  lines.push(...formatSubscriptionsBlock(getChatSubscriptions(subscriptionsState, chatId)));

  return lines.join("\n");
}

async function buildWelcomePricesMessage() {
  const lines = ["Precios actuales de referencia por tipo:"];

  try {
    const matches = filterMatches(await fetchSingleMatchInventory(), { match: DEFAULT_MATCHES })
      .sort((a, b) => Number(a.MatchNumber) - Number(b.MatchNumber));

    for (const match of matches) {
      lines.push("");
      lines.push(`M${match.MatchNumber} ${match.HostTeam?.ExternalName || "TBD"} vs ${match.OpposingTeam?.ExternalName || "TBD"}:`);

      const lounges = await fetchSingleMatchLounges(match.PerformanceId);
      for (const line of lounges.map(formatLoungePriceLine).filter(Boolean)) {
        lines.push(line);
      }
    }

    lines.push("");
    lines.push("Los precios son 'desde' y pueden cambiar. El monitoreo automático sigue enfocado en tus alertas guardadas.");
  } catch (error) {
    return "No pude cargar los precios en este momento, pero el monitor sigue activo.";
  }

  return lines.join("\n");
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function latestCheckedAt(state) {
  return Object.values(state || {})
    .map((item) => item?.checkedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
}

async function buildStatusMessage(chatId, subscriptionsState) {
  const monitorState = await readState(DEFAULT_STATE_FILE);
  const lastCheck = latestCheckedAt(monitorState);
  const chatEntries = Object.entries(subscriptionsState.chats || {});
  const currentSubscriptions = getChatSubscriptions(subscriptionsState, chatId);
  const savedAlertsCount = chatEntries.reduce((total, [, chatState]) => {
    return total + (chatState.subscriptions?.length || 0);
  }, 0);

  return [
    "Estado del bot",
    "",
    "Activo: si",
    `Último chequeo: ${lastCheck ? new Date(lastCheck).toLocaleString("es-AR") : "todavía no registrado"}`,
    `Tiempo encendido: ${formatDuration(process.uptime() * 1000)}`,
    `Tus alertas: ${currentSubscriptions.length}`,
    `Chats con alertas: ${chatEntries.length}`,
    `Alertas totales: ${savedAlertsCount}`,
    "",
    "El bot revisa disponibilidad cada 60 segundos."
  ].join("\n");
}

function stateKey(summary, options) {
  const scope = options.allSections
    ? "all-sections"
    : options.sectionCode || options.section || "selected-section";
  return `${summary.match}:${scope}`;
}

async function checkOnce(options) {
  const matches = await fetchSingleMatchInventory();
  const filteredMatches = filterMatches(matches, options);

  if (!filteredMatches.length) {
    throw new Error(`No matches found for filters: ${JSON.stringify({
      match: options.match,
      venue: options.venue,
      team: options.team
    })}`);
  }

  const summaries = await Promise.all(filteredMatches.map(async (match) => {
    if (options.allSections) return summarizeMatch(match);

    const lounges = await fetchSingleMatchLounges(match.PerformanceId);
    const hospitalityOptions = getHospitalityOptions(lounges, {
      section: options.section,
      sectionCode: options.sectionCode
    });

    return summarizeMatch(match, { hospitalityOptions });
  }));

  const state = await readState(options.stateFile);
  const nextState = { ...state };
  const alerts = [];

  for (const summary of summaries) {
    const key = stateKey(summary, options);
    const previous = state[key];
    const becameAvailable = summary.isAvailable && previous?.isAvailable === false;
    const firstSeenAvailable = summary.isAvailable && previous == null;

    if (becameAvailable || firstSeenAvailable) alerts.push(summary);

    nextState[key] = {
      isAvailable: summary.isAvailable,
      minAvailablePrice: summary.minAvailablePrice,
      cheapestSelectedPrice: summary.cheapestSelectedPrice,
      cheapestLounge: summary.cheapestLounge,
      selectedSection: summary.selectedSection,
      selectedSectionCode: summary.selectedSectionCode,
      isOffered: summary.isOffered,
      checkedAt: new Date().toISOString()
    };
  }

  await writeState(options.stateFile, nextState);

  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Checked ${summaries.length} match(es)`);
  for (const summary of summaries) console.log(`- ${formatSummary(summary)}`);

  for (const alert of alerts) {
    console.log(`ALERT: ${formatSummary(alert)}`);
  }

  if (alerts.length && telegramIsConfigured()) {
    for (const alert of alerts) {
      try {
        await sendTelegramMessage(formatTelegramAlert(alert), {
          replyMarkup: matchUrlKeyboard(alert)
        });
        console.log(`Telegram sent: ${alert.match}`);
      } catch (error) {
        console.error(`Telegram failed for ${alert.match}: ${error.message}`);
      }
    }
  } else if (alerts.length) {
    console.log("Telegram not configured; alert printed only.");
  }

  return { summaries, alerts };
}

async function summarizeSubscription(match, subscription) {
  if (subscription.allSections) return summarizeMatch(match);

  const lounges = await fetchSingleMatchLounges(match.PerformanceId);
  const hospitalityOptions = getHospitalityOptions(lounges, {
    section: subscription.section,
    sectionCode: subscription.sectionCode
  });

  return summarizeMatch(match, { hospitalityOptions });
}

async function checkSubscriptions() {
  const subscriptionsState = normalizeSubscriptionState(await readState(SUBSCRIPTIONS_FILE));
  const chatEntries = Object.entries(subscriptionsState.chats || {});
  if (!chatEntries.length) return;

  const matches = await fetchSingleMatchInventory();
  const state = await readState(DEFAULT_STATE_FILE);
  const nextState = { ...state };
  let checkedCount = 0;

  for (const [chatId, chatState] of chatEntries) {
    const subscriptions = chatState.subscriptions?.length ? chatState.subscriptions : DEFAULT_SUBSCRIPTIONS;

    for (const subscription of subscriptions) {
      const matchNumber = normalizeMatchInput(subscription.match);
      const match = filterMatches(matches, { match: matchNumber })[0];
      if (!match) continue;

      checkedCount += 1;
      const key = `${chatId}:${subscriptionKey(subscription)}`;
      let summary;

      try {
        summary = await summarizeSubscription(match, subscription);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Failed checking ${key}: ${error.message}`);
        nextState[key] = {
          isAvailable: false,
          isOffered: null,
          error: error.message,
          checkedAt: new Date().toISOString()
        };
        continue;
      }

      const previous = state[key];
      const becameAvailable = summary.isAvailable && previous?.isAvailable === false;
      const firstSeenAvailable = summary.isAvailable && previous == null;

      if (becameAvailable || firstSeenAvailable) {
        await sendTelegramMessage(formatTelegramAlertForSubscription(summary, subscription), {
          chatId,
          replyMarkup: matchUrlKeyboard(summary)
        });
        console.log(`Telegram sent: ${summary.match} to chat ${chatId}`);
      }

      nextState[key] = {
        isAvailable: summary.isAvailable,
        minAvailablePrice: summary.minAvailablePrice,
        cheapestSelectedPrice: summary.cheapestSelectedPrice,
        selectedSection: summary.selectedSection,
        selectedSectionCode: summary.selectedSectionCode,
        isOffered: summary.isOffered,
        error: null,
        checkedAt: new Date().toISOString()
      };
    }
  }

  await writeState(DEFAULT_STATE_FILE, nextState);

  console.log(`[${new Date().toISOString()}] Checked ${checkedCount} saved alert(s) for ${chatEntries.length} chat(s)`);
}

async function buildPricesMessage(matchInput) {
  const matchNumber = normalizeMatchInput(matchInput);
  if (!matchNumber) return "Uso: /precios M86";

  const match = filterMatches(await fetchSingleMatchInventory(), { match: matchNumber })[0];
  if (!match) return `No encontre ${matchNumber}.`;

  const lines = [
    `${matchNumber} ${match.HostTeam?.ExternalName || "TBD"} vs ${match.OpposingTeam?.ExternalName || "TBD"}`,
    `${match.Venue?.Name || match.Venue?.Code}${match.Venue?.Town ? `, ${match.Venue.Town}` : ""}`,
    `${match.MatchDate} ${match.MatchDayTime}`,
    ""
  ];

  const lounges = await fetchSingleMatchLounges(match.PerformanceId);
  for (const line of lounges.map(formatLoungePriceLine).filter(Boolean)) {
    lines.push(line.trim());
  }

  return lines.join("\n");
}

function helpMessage() {
  return [
    "Comandos disponibles:",
    "",
    "También podés usar los botones de abajo para configurar tus alertas.",
    "",
    "/seguir M70 Suite Essentials",
    "/seguir M86 all",
    "/seguir M86 VIP",
    "/precios M86",
    "/lista",
    "/menu",
    "/estado",
    "/quitar M70",
    "/reiniciar",
    "/start",
    "",
    "Categorías útiles: Suite Essentials, VIP, Pitchside, Trophy, Champions, FIFA Pavilion, all.",
    "Podés usar cualquier partido del M1 al M104. Ejemplo: /seguir M75 all.",
    "",
    "Este bot no es oficial de FIFA. Solo avisa disponibilidad; no reserva ni compra entradas.",
    "",
    "También acepto los comandos anteriores en inglés: /watch, /prices, /list, /remove, /reset, /help."
  ].join("\n");
}

async function firstExistingPath(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  return undefined;
}

async function handleTelegramCommands() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;

  const state = await readState(TELEGRAM_BOT_STATE_FILE);
  const subscriptionsState = normalizeSubscriptionState(await readState(SUBSCRIPTIONS_FILE));
  const updates = await getTelegramUpdates({ offset: state.offset });
  const nextState = { ...state, pending: { ...(state.pending || {}) } };
  const startChats = new Set();

  for (const update of updates.result || []) {
    nextState.offset = update.update_id + 1;

    const callback = update.callback_query;
    if (callback) {
      const chatId = callback.message?.chat?.id;
      const data = callback.data || "";

      if (!chatId) {
        await safelyAnswerCallbackQuery(callback.id);
        continue;
      }

      rememberChat(subscriptionsState, chatId, callback.message?.chat, callback.from);

      const answerText = callbackAnswerText(data);
      await safelyAnswerCallbackQuery(callback.id, answerText ? { text: answerText } : {});

      if (data === "menu") {
        await sendTelegramMessage(menuMessage(), {
          chatId,
          replyMarkup: mainMenuKeyboard()
        });
        continue;
      }

      if (data === "ayuda") {
        await sendTelegramMessage(helpMessage(), {
          chatId,
          replyMarkup: mainMenuKeyboard()
        });
        continue;
      }

      if (data === "estado") {
        await safelySendChatAction(chatId);
        await sendTelegramMessage(await buildStatusMessage(chatId, subscriptionsState), {
          chatId,
          replyMarkup: mainMenuKeyboard()
        });
        continue;
      }

      if (data === "lista") {
        await sendTelegramMessage(subscriptionsMessage(getChatSubscriptions(subscriptionsState, chatId)), {
          chatId,
          replyMarkup: mainMenuKeyboard()
        });
        continue;
      }

      if (data === "reiniciar") {
        setChatSubscriptions(subscriptionsState, chatId, DEFAULT_SUBSCRIPTIONS);
        await sendTelegramMessage("Listo. Volví a M70 y M86 con Suite Essentials.", {
          chatId,
          replyMarkup: mainMenuKeyboard()
        });
        continue;
      }

      if (data.startsWith("precios:")) {
        await safelySendChatAction(chatId);
        await sendTelegramMessage(await buildPricesMessage(data.split(":")[1]), {
          chatId,
          replyMarkup: mainMenuKeyboard()
        });
        continue;
      }

      if (data === "precios_otro") {
        setPendingAction(nextState, chatId, { action: "precios" });
        await sendTelegramMessage("Mandame el número de partido para consultar precios. Ejemplo: M75", { chatId });
        continue;
      }

      if (data.startsWith("seguir:")) {
        const subscription = subscriptionFromCallbackData(data);
        if (!subscription) {
          await sendTelegramMessage("No pude interpretar esa alerta. Probá con /ayuda.", {
            chatId,
            replyMarkup: mainMenuKeyboard()
          });
          continue;
        }

        addSubscription(subscriptionsState, chatId, subscription);
        await sendTelegramMessage(`Listo. Agregué alerta: ${formatSubscription(subscription)}`, {
          chatId,
          replyMarkup: mainMenuKeyboard()
        });
        continue;
      }

      if (data.startsWith("otro:")) {
        const sectionInput = data.split(":")[1] || DEFAULT_SECTION;
        setPendingAction(nextState, chatId, {
          action: "seguir",
          sectionInput
        });
        const section = normalizeSectionInput(sectionInput);
        const scope = section.allSections ? "todas las categorías" : section.section || DEFAULT_SECTION;
        await sendTelegramMessage(`Mandame el número de partido para seguir ${scope}. Ejemplo: M75`, { chatId });
        continue;
      }

      await sendTelegramMessage("No reconozco ese botón. Probá con /ayuda.", {
        chatId,
        replyMarkup: mainMenuKeyboard()
      });
      continue;
    }

    const message = update.message || update.channel_post;
    const text = message?.text?.trim();
    const chatId = message?.chat?.id;

    if (!chatId || !text) continue;

    rememberChat(subscriptionsState, chatId, message.chat, message.from);

    const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

    if (!command.startsWith("/")) {
      const pendingAction = popPendingAction(nextState, chatId);
      if (pendingAction) {
        const match = normalizeMatchInput(text.split(/\s+/)[0]);
        if (!match || !isValidMatchNumber(match)) {
          setPendingAction(nextState, chatId, pendingAction);
          await sendTelegramMessage("No pude entender el partido. Mandame algo como M75 o 75.", {
            chatId,
            replyMarkup: mainMenuKeyboard()
          });
          continue;
        }

        if (pendingAction.action === "precios") {
          await safelySendChatAction(chatId);
          await sendTelegramMessage(await buildPricesMessage(match), {
            chatId,
            replyMarkup: mainMenuKeyboard()
          });
          continue;
        }

        if (pendingAction.action === "seguir") {
          const subscription = {
            match,
            ...normalizeSectionInput(pendingAction.sectionInput || DEFAULT_SECTION)
          };
          addSubscription(subscriptionsState, chatId, subscription);
          await sendTelegramMessage(`Listo. Agregué alerta: ${formatSubscription(subscription)}`, {
            chatId,
            replyMarkup: mainMenuKeyboard()
          });
          continue;
        }
      }
    }

    if (command === "/start") {
      await safelySendChatAction(chatId);
      if (!subscriptionsState.chats?.[String(chatId)]?.subscriptions?.length) {
        setChatSubscriptions(subscriptionsState, chatId, DEFAULT_SUBSCRIPTIONS);
      }
      startChats.add(chatId);
      continue;
    }

    if (command === "/help" || command === "/ayuda") {
      await sendTelegramMessage(helpMessage(), {
        chatId,
        replyMarkup: mainMenuKeyboard()
      });
      continue;
    }

    if (command === "/menu") {
      await sendTelegramMessage(menuMessage(), {
        chatId,
        replyMarkup: mainMenuKeyboard()
      });
      continue;
    }

    if (command === "/status" || command === "/estado") {
      await safelySendChatAction(chatId);
      await sendTelegramMessage(await buildStatusMessage(chatId, subscriptionsState), {
        chatId,
        replyMarkup: mainMenuKeyboard()
      });
      continue;
    }

    if (command === "/watch" || command === "/seguir") {
      const subscription = parseWatchCommand(text);
      if (!subscription || !isValidMatchNumber(subscription.match)) {
        await sendTelegramMessage("Uso: /seguir M70 Suite Essentials o /seguir M86 all", { chatId });
        continue;
      }

      addSubscription(subscriptionsState, chatId, subscription);
      await sendTelegramMessage(`Listo. Agregué alerta: ${formatSubscription(subscription)}`, {
        chatId,
        replyMarkup: mainMenuKeyboard()
      });
      continue;
    }

    if (command === "/list" || command === "/lista") {
      const current = getChatSubscriptions(subscriptionsState, chatId);
      await sendTelegramMessage(subscriptionsMessage(current), {
        chatId,
        replyMarkup: mainMenuKeyboard()
      });
      continue;
    }

    if (command === "/remove" || command === "/quitar") {
      const match = normalizeMatchInput(text.split(/\s+/)[1]);
      if (!match) {
        await sendTelegramMessage("Uso: /quitar M70", { chatId });
        continue;
      }

      const current = getChatSubscriptions(subscriptionsState, chatId);
      const next = current.filter((subscription) => subscription.match !== match);
      setChatSubscriptions(subscriptionsState, chatId, next);
      await sendTelegramMessage(`Listo. Quité las alertas de ${match}.`, {
        chatId,
        replyMarkup: mainMenuKeyboard()
      });
      continue;
    }

    if (command === "/reset" || command === "/reiniciar") {
      setChatSubscriptions(subscriptionsState, chatId, DEFAULT_SUBSCRIPTIONS);
      await sendTelegramMessage("Listo. Volví a M70 y M86 con Suite Essentials.", {
        chatId,
        replyMarkup: mainMenuKeyboard()
      });
      continue;
    }

    if (command === "/prices" || command === "/precios") {
      await safelySendChatAction(chatId);
      await sendTelegramMessage(await buildPricesMessage(text.split(/\s+/)[1]), {
        chatId,
        replyMarkup: mainMenuKeyboard()
      });
      continue;
    }
  }

  for (const chatId of startChats) {
    const imagePath = await firstExistingPath(START_IMAGE_CANDIDATES);
    const messageText = await buildWelcomeMessage(chatId, subscriptionsState);

    if (imagePath) {
      await safelySendChatAction(chatId, "upload_photo");
      await sendTelegramPhoto(imagePath, {
        chatId
      });
      await safelySendChatAction(chatId);
      await sendTelegramMessage(messageText, {
        chatId,
        replyMarkup: mainMenuKeyboard()
      });
    } else {
      await safelySendChatAction(chatId);
      await sendTelegramMessage(messageText, {
        chatId,
        replyMarkup: mainMenuKeyboard()
      });
    }

    console.log(`Telegram /start answered for chat ${chatId}`);

    await writeState(TELEGRAM_BOT_STATE_FILE, nextState);
    await writeSubscriptionsState(subscriptionsState);

    await safelySendChatAction(chatId);
    await sendTelegramMessage(await buildWelcomePricesMessage(), {
      chatId,
      replyMarkup: mainMenuKeyboard()
    });
  }

  await writeState(TELEGRAM_BOT_STATE_FILE, nextState);
  await writeSubscriptionsState(subscriptionsState);
}

async function main() {
  await loadDotEnv();

  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  try {
    await handleTelegramCommands();
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Telegram command handling failed: ${error.message}`);
  }

  if (options.once) {
    try {
      await checkOnce(options);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  let nextSubscriptionCheckAt = 0;
  let subscriptionCheckPromise = null;

  do {
    try {
      await handleTelegramCommands();
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Telegram command handling failed: ${error.message}`);
    }

    if (Date.now() >= nextSubscriptionCheckAt && !subscriptionCheckPromise) {
      nextSubscriptionCheckAt = Date.now() + options.interval * 1000;
      subscriptionCheckPromise = checkSubscriptions()
        .catch((error) => {
          console.error(`[${new Date().toISOString()}] ${error.message}`);
        })
        .finally(() => {
          subscriptionCheckPromise = null;
        });
    }

    await new Promise((resolve) => setTimeout(resolve, COMMAND_POLL_INTERVAL_SECONDS * 1000));
  } while (true);
}

main();
