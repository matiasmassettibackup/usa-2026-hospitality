import { access } from "node:fs/promises";
import { loadDotEnv } from "./config.js";
import {
  createSingleMatchCart,
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
import {
  appendCsvRows,
  readState,
  stateBackend,
  writeState
} from "./stateStore.js";

const DEFAULT_STATE_FILE = ".state/hospitality-monitor.json";
const TELEGRAM_BOT_STATE_FILE = ".state/telegram-bot.json";
const SUBSCRIPTIONS_FILE = ".state/subscriptions.json";
const CART_ALLOCATIONS_KEY = "__cartAllocations";
const AVAILABILITY_EVENTS_KEY = "__availabilityEvents";
const AVAILABILITY_EVENTS_FILE = ".state/availability-events.csv";
const AVAILABILITY_LOG_MATCHES = ["M104"];
const DEFAULT_SECTION = "Suite Essentials";
const DEFAULT_MATCHES = "M104";
const COMMAND_POLL_INTERVAL_SECONDS = 1;
const CART_EXPIRY_MINUTES = 15;
const DEFAULT_ADMIN_CART_NOTIFY_WATCH = "";
const START_IMAGE_CANDIDATES = [
  "assets/la-banda-argentina.png",
  "assets/la-banda-argentina.jpg",
  "/Users/matiasmassetti/Downloads/la-banda-argentina.png",
  "/Users/matiasmassetti/Downloads/la-banda-argentina.jpg"
];

const DEFAULT_SUBSCRIPTIONS = [
  { match: "M104", cheapestPerCategory: true }
];
const RESET_SUBSCRIPTIONS = [
  { match: "M104", cheapestPerCategory: true }
];

const SECTION_ALIASES = new Map([
  ["all", { allSections: true }],
  ["todo", { allSections: true }],
  ["todos", { allSections: true }],
  ["any", { allSections: true }],
  ["cheap", { cheapestPerCategory: true }],
  ["cheapest", { cheapestPerCategory: true }],
  ["barata", { cheapestPerCategory: true }],
  ["baratas", { cheapestPerCategory: true }],
  ["mas barata", { cheapestPerCategory: true }],
  ["más barata", { cheapestPerCategory: true }],
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
    cheapestPerCategory: false,
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
    else if (arg === "--cheapest-per-category") options.cheapestPerCategory = true;
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
  node src/monitor.js --once --match M104
  node src/monitor.js --once --match M104 --cheapest-per-category
  node src/monitor.js --match M104 --cheapest-per-category --interval 60
  node src/monitor.js --once --venue NN_DAL
  node src/monitor.js --once --team Argentina
  node src/monitor.js --once --match M104 --all-sections

Options:
  --match M104                 Match number(s) to watch. Defaults to M104.
  --venue NN_DAL               Optional venue filter.
  --team Argentina             Optional team name filter.
  --section "Suite Essentials" Seating section to watch. Defaults to Suite Essentials.
  --section-code MEL           Seating section code to watch.
  --all-sections               Watch any hospitality section instead of Suite Essentials.
  --cheapest-per-category      Watch only the cheapest ticket in each hospitality category.
  --interval 60                Polling interval in seconds. Defaults to 60.
  --once                       Run one check and exit.
  --state PATH                 State file used to detect unavailable -> available changes.
`);
}

async function writeSubscriptionsState(nextState, changedChatIds) {
  const currentState = await readState(SUBSCRIPTIONS_FILE);
  const mergedState = {
    ...nextState,
    chats: { ...(nextState.chats || {}) }
  };
  const changedChats = changedChatIds ? new Set([...changedChatIds].map(String)) : null;

  for (const [chatId, currentChat] of Object.entries(currentState.chats || {})) {
    if (changedChats && !changedChats.has(String(chatId))) {
      mergedState.chats[chatId] = currentChat;
      continue;
    }

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

function autoCartEnabled() {
  return String(process.env.AUTO_CART_ENABLED || "").toLowerCase() === "true";
}

function autoCartMaxPerEvent() {
  const value = String(process.env.AUTO_CART_MAX_PER_EVENT || "1").trim().toLowerCase();
  if (value === "all") return Number.POSITIVE_INFINITY;

  const count = Number(value);
  if (!Number.isFinite(count) || count < 1) return 1;
  return Math.floor(count);
}

function autoCartDisabledMatches() {
  return new Set(
    String(process.env.AUTO_CART_DISABLED_MATCHES || "")
      .split(",")
      .map((value) => normalizeMatchInput(value))
      .filter(Boolean)
  );
}

export function autoCartAllowedForMatch(match) {
  return !autoCartDisabledMatches().has(normalizeMatchInput(match));
}

function adminChatIds() {
  return new Set(
    String(process.env.ADMIN_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function isAdminChat(chatId) {
  return adminChatIds().has(String(chatId));
}

function adminCartNotifyChatIds() {
  return String(process.env.ADMIN_CART_NOTIFY_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function adminCartNotifyWatchSet() {
  return new Set(
    String(process.env.ADMIN_CART_NOTIFY_WATCH || DEFAULT_ADMIN_CART_NOTIFY_WATCH)
      .split(",")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean)
  );
}

function shouldNotifyAdminCartAssignment({ chatId, summary, option }) {
  const key = `${chatId}:${summary.match}:${option.sectionCode}`.toUpperCase();
  return adminCartNotifyWatchSet().has(key);
}

function userPriority(chatState = {}) {
  const value = Number(chatState.user?.priority ?? chatState.priority ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function compareUserPriority(aChatState, bChatState) {
  const aPriority = userPriority(aChatState);
  const bPriority = userPriority(bChatState);
  const aRanked = aPriority > 0;
  const bRanked = bPriority > 0;

  if (aRanked && !bRanked) return -1;
  if (!aRanked && bRanked) return 1;
  if (aRanked && bRanked && aPriority !== bPriority) return aPriority - bPriority;
  return 0;
}

function desiredAutoCartQuantity(candidate) {
  const value = Number(
    candidate.subscription?.quantity ??
    candidate.subscription?.autoCartQuantity ??
    candidate.subscription?.cartQuantity ??
    1
  );
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(6, Math.floor(value));
}

function setUserPriority(subscriptionsState, chatId, priority) {
  const key = String(chatId);
  subscriptionsState.chats = subscriptionsState.chats || {};
  const current = subscriptionsState.chats[key] || {};
  subscriptionsState.chats[key] = {
    ...current,
    priority,
    user: {
      ...(current.user || {}),
      chatId: key,
      priority
    }
  };
}

function subscriptionKey(subscription) {
  const scope = subscription.cheapestPerCategory
    ? "cheapest"
    : subscription.allSections
    ? "all"
    : subscription.sectionCode || subscription.section || DEFAULT_SECTION;
  const maxPrice = Number(subscription.maxPriceUsd);
  const priceScope = Number.isFinite(maxPrice) ? `:max${maxPrice}` : "";
  return `${subscription.match}:${scope}${priceScope}`;
}

function formatSubscription(subscription) {
  let scope = subscription.cheapestPerCategory
    ? "mas barata por categoria"
    : subscription.allSections
    ? "todas las categorías"
    : subscription.section || subscription.sectionCode || DEFAULT_SECTION;
  const maxPrice = Number(subscription.maxPriceUsd);
  if (Number.isFinite(maxPrice)) scope += ` hasta ${formatMoney(maxPrice)}`;
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
  if (Array.isArray(chatState?.subscriptions)) return chatState.subscriptions;
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
  const priority = userPriority(current);
  const user = {
    ...(current.user || {}),
    chatId: key,
    priority,
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
    priority,
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
        { text: "Precios M104", callback_data: "precios:M104" }
      ],
      [
        { text: "Seguir M104 baratas", callback_data: "seguir:M104:cheap" }
      ],
      [
        { text: "Otro partido Suite", callback_data: "otro:suite" },
        { text: "Otro partido baratas", callback_data: "otro:cheap" }
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
  if (data.startsWith("cart:")) return "Creando carrito...";
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

function cartAllocationKey(summaryOrMatch, sectionCode) {
  const match = typeof summaryOrMatch === "string" ? summaryOrMatch : summaryOrMatch.match;
  const code = sectionCode || summaryOrMatch.selectedSectionCode;
  return `${match}:${String(code || "").toUpperCase()}`;
}

function matchUrl(summary) {
  return `https://fifaworldcup26.hospitality.fifa.com/us/en/choose-matches?venue=${summary.venueCode}`;
}

function matchUrlKeyboard(summary) {
  const buttons = [];

  if (summary.selectedSectionCode) {
    buttons.push([
      {
        text: "Crear carrito",
        callback_data: `cart:${summary.match}:${summary.selectedSectionCode}`
      }
    ]);
  }

  buttons.push([
    { text: "Abrir FIFA manual", url: matchUrl(summary) }
  ]);
  buttons.push([
    { text: "Mis alertas", callback_data: "lista" },
    { text: "Estado", callback_data: "estado" }
  ]);

  return {
    inline_keyboard: buttons
  };
}

function formatTelegramAlert(summary) {
  const price = formatMoney(summary.minAvailablePrice ?? summary.cheapestSelectedPrice);
  const section = summary.selectedSection || summary.cheapestLounge || "Hospitality";
  const quantity = summary.availableQuantity ? ` (${summary.availableQuantity} disp.)` : "";

  return [
    "Alerta FIFA Hospitality",
    "",
    `${summary.match} - ${summary.teams}`,
    `${section}: DISPONIBLE desde ${price}${quantity}`,
    `${summary.venue || summary.venueCode}${summary.city ? `, ${summary.city}` : ""}`,
    `${summary.date} ${summary.dayTime}`,
    "",
    "Tocá Crear carrito para generar el link oficial de FIFA. No compra ni hace checkout."
  ].join("\n");
}

function formatTelegramAlertForSubscription(summary, subscription, { autoCartAssignedToAnotherUser = false } = {}) {
  const price = formatMoney(summary.minAvailablePrice ?? summary.cheapestSelectedPrice);
  const section = summary.selectedSection || summary.cheapestLounge || subscription.section || "Hospitality";
  const quantity = summary.availableQuantity ? ` (${summary.availableQuantity} disp.)` : "";
  const lines = [
    "Alerta FIFA Hospitality",
    "",
    `${summary.match} - ${summary.teams}`,
    `${section}: DISPONIBLE desde ${price}${quantity}`,
    `${summary.venue || summary.venueCode}${summary.city ? `, ${summary.city}` : ""}`,
    `${summary.date} ${summary.dayTime}`,
    "",
    "Tocá Crear carrito para generar el link oficial de FIFA. No compra ni hace checkout."
  ];

  if (autoCartAssignedToAnotherUser) {
    lines.push(
      "",
      "Nota: el carrito automático fue asignado a otro usuario con mayor prioridad. Cualquier cosa, comunicate con Matías."
    );
  }

  return lines.join("\n");
}

function formatAutoCartMessage({ summary, option, cart }) {
  const quantity = Number(cart.SelectedQuantity || cart.Quantity || cart.quantity || 1) || 1;
  const expiresAt = new Date(Date.now() + CART_EXPIRY_MINUTES * 60 * 1000);

  return [
    "Carrito FIFA asignado",
    "",
    `${summary.match} - ${summary.teams}`,
    `${option.sectionName}: ${formatMoney(option.amount)} x ${quantity}`,
    `Total: ${formatMoney(cart.SelectionTotalAmount ?? option.amount * quantity)}`,
    "",
    cart.CheckoutRedirectUrl,
    "",
    `Este link abre el carrito oficial de FIFA y suele expirar en aprox. ${CART_EXPIRY_MINUTES} minutos (${expiresAt.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}).`,
    "No hice checkout ni pago."
  ].join("\n");
}

function formatAdminAutoCartNotification({ summary, option, winnerChatId, cart }) {
  const quantity = Number(cart.SelectedQuantity || cart.Quantity || cart.quantity || 1) || 1;
  return [
    "Confirmación carrito prioritario",
    "",
    `Usuario: ${winnerChatId}`,
    `${summary.match} - ${summary.teams}`,
    `${option.sectionName}: ${formatMoney(option.amount)} x ${quantity}`,
    `Orden FIFA: ${cart.OrderId}`,
    "",
    "El link de carrito fue enviado correctamente al usuario prioritario."
  ].join("\n");
}

function baseWelcomeLines() {
  return [
    "Hola! Soy el bot de Hospitality 2026.",
    "Creado por Matias Massetti.",
    "",
    "Por defecto ya estoy mirando M104 en la entrada más barata de cada categoría de hospitality.",
    "Si aparece disponibilidad en ese partido, te aviso y preparo carrito automático según prioridad si está activado.",
    "",
    "Si aparece disponibilidad, te mando una alerta con partido, sede, precio y link.",
    "",
    "Aviso: este bot no es oficial de FIFA. Puede crear un link de carrito cuando tocás el botón, pero no hace checkout ni compra entradas.",
    "",
    "Chequeo cada 60 segundos.",
    "",
    "Usá los botones para cambiar alertas, ver precios o seguir otros partidos.",
    "",
    "Los precios son valores 'desde' y pueden cambiar. Tocá Precios M104 para verlos actualizados."
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
  if (!subscriptions.length) {
    return [
      "Tus alertas:",
      "- ninguna"
    ];
  }

  return [
    "Tus alertas:",
    ...subscriptions.map((subscription) => `- ${formatSubscription(subscription)}`)
  ];
}

function prioritiesMessage(subscriptionsState) {
  const chats = Object.entries(subscriptionsState.chats || {})
    .map(([chatId, chatState]) => {
      const user = chatState.user || {};
      const name = user.username
        ? `@${user.username}`
        : [user.firstName, user.lastName].filter(Boolean).join(" ") || user.chatTitle || `Chat ${chatId}`;
      return {
        chatId,
        name,
        priority: userPriority(chatState),
        alerts: chatState.subscriptions?.length || 0
      };
    })
    .sort((a, b) => b.priority - a.priority || a.chatId.localeCompare(b.chatId));

  if (!chats.length) return "Todavía no tengo usuarios guardados.";

  return [
    "Prioridades",
    "",
    ...chats.map((chat) => `${chat.priority} - ${chat.name} (${chat.chatId}, ${chat.alerts} alertas)`)
  ].join("\n");
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
    `Auto-carrito: ${autoCartEnabled() ? "activo" : "apagado"}`,
    "",
    "El bot revisa disponibilidad cada 60 segundos."
  ].join("\n");
}

function stateKey(summary, options) {
  const scope = options.cheapestPerCategory
    ? "cheapest"
    : options.allSections
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
    const lounges = await fetchSingleMatchLounges(match.PerformanceId);
    const hospitalityOptions = getHospitalityOptions(lounges, {
      section: options.section,
      sectionCode: options.sectionCode,
      allSections: options.allSections,
      cheapestPerCategory: options.cheapestPerCategory
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
      availableQuantity: summary.availableQuantity,
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
  const lounges = await fetchSingleMatchLounges(match.PerformanceId);
  const hospitalityOptions = getHospitalityOptions(lounges, {
    section: subscription.section,
    sectionCode: subscription.sectionCode,
    allSections: subscription.allSections,
    cheapestPerCategory: subscription.cheapestPerCategory,
    maxPriceUsd: subscription.maxPriceUsd
  });

  return summarizeMatch(match, { hospitalityOptions });
}

function availabilityEventKey(summary, option) {
  return `${summary.match}:${option.sectionCode || option.sectionName || option.loungeTitle || "unknown"}`;
}

export function collectAvailabilityEventsForSummary(summary, previousEvents = {}, timestamp = new Date().toISOString()) {
  const events = [];
  const activeKeys = new Set();
  const nextEvents = {};

  for (const option of summary.availableOptions || []) {
    const key = availabilityEventKey(summary, option);
    activeKeys.add(key);

    if (!previousEvents[key]?.active) {
      events.push({
        timestamp,
        match: summary.match,
        teams: summary.teams,
        venue: summary.venue,
        city: summary.city,
        date: summary.dayTime || summary.date,
        sectionCode: option.sectionCode,
        sectionName: option.sectionName,
        loungeTitle: option.loungeTitle || option.loungeName,
        priceUsd: option.amount,
        availableQuantity: option.availableQuantity,
        canCreateCart: option.canCreateCart === false ? "false" : "true"
      });
    }

    nextEvents[key] = {
      active: true,
      match: summary.match,
      sectionCode: option.sectionCode,
      sectionName: option.sectionName,
      loungeTitle: option.loungeTitle || option.loungeName,
      priceUsd: option.amount,
      availableQuantity: option.availableQuantity,
      firstSeenAt: previousEvents[key]?.firstSeenAt || timestamp,
      lastSeenAt: timestamp,
      lastEventAt: previousEvents[key]?.active ? previousEvents[key]?.lastEventAt : timestamp
    };
  }

  return { events, activeKeys, nextEvents };
}

async function recordAvailabilityEvents(matches, nextState) {
  const previousEvents = nextState[AVAILABILITY_EVENTS_KEY] || {};
  const nextEvents = {};
  const rows = [];
  const activeKeys = new Set();
  const timestamp = new Date().toISOString();
  const targetMatches = filterMatches(matches, { match: AVAILABILITY_LOG_MATCHES.join(",") });

  for (const match of targetMatches) {
    try {
      const lounges = await fetchSingleMatchLounges(match.PerformanceId);
      const summary = summarizeMatch(match, {
        hospitalityOptions: getHospitalityOptions(lounges, { allSections: true })
      });
      const collected = collectAvailabilityEventsForSummary(summary, previousEvents, timestamp);

      rows.push(...collected.events);
      for (const key of collected.activeKeys) activeKeys.add(key);
      Object.assign(nextEvents, collected.nextEvents);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Availability CSV failed for M${match.MatchNumber}: ${error.message}`);
    }
  }

  for (const [key, previous] of Object.entries(previousEvents)) {
    if (activeKeys.has(key)) continue;
    if (!AVAILABILITY_LOG_MATCHES.some((match) => key.startsWith(`${match}:`))) {
      nextEvents[key] = previous;
      continue;
    }
    nextEvents[key] = {
      ...previous,
      active: false,
      lastMissingAt: timestamp
    };
  }

  nextState[AVAILABILITY_EVENTS_KEY] = nextEvents;

  await appendCsvRows(AVAILABILITY_EVENTS_FILE, [
    "timestamp",
    "match",
    "teams",
    "venue",
    "city",
    "date",
    "sectionCode",
    "sectionName",
    "loungeTitle",
    "priceUsd",
    "availableQuantity",
    "canCreateCart"
  ], rows);

  if (rows.length) {
    console.log(`[${timestamp}] Logged ${rows.length} availability event(s) to ${AVAILABILITY_EVENTS_FILE}`);
  }

  return rows;
}

export function selectAutoCartWinners(allocationCandidates, allocations = {}) {
  const grouped = new Map();

  for (const candidate of allocationCandidates) {
    const key = cartAllocationKey(candidate.summary);
    if (!candidate.summary.cartOption || allocations[key]?.active) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(candidate);
  }

  const maxPerEvent = autoCartMaxPerEvent();

  return [...grouped.entries()].map(([key, candidates]) => {
    candidates.sort((a, b) => {
      const priorityDiff = compareUserPriority(a.chatState, b.chatState);
      if (priorityDiff !== 0) return priorityDiff;

      const aTime = a.chatState.user?.firstSeenAt || "";
      const bTime = b.chatState.user?.firstSeenAt || "";
      const timeDiff = aTime.localeCompare(bTime);
      if (timeDiff !== 0) return timeDiff;

      return String(a.chatId).localeCompare(String(b.chatId));
    });

    const availableQuantity = Number(candidates[0]?.summary.availableQuantity);
    const quantityLimit = Number.isFinite(availableQuantity) && availableQuantity > 0
      ? Math.floor(availableQuantity)
      : candidates.length;
    const winners = [];
    let remainingQuantity = quantityLimit;

    for (const candidate of candidates) {
      if (winners.length >= maxPerEvent || remainingQuantity <= 0) break;
      const cartQuantity = Math.min(desiredAutoCartQuantity(candidate), remainingQuantity);
      winners.push({ ...candidate, cartQuantity });
      remainingQuantity -= cartQuantity;
    }

    return { key, winner: winners[0], winners };
  });
}

function allocationIsActive(allocation, now = new Date()) {
  if (!allocation?.active) return false;

  const items = Array.isArray(allocation.items) ? allocation.items : [];
  if (items.length) {
    return items.some((item) => {
      if (!item.expiresAt) return true;
      return new Date(item.expiresAt).getTime() > now.getTime();
    });
  }

  if (!allocation.expiresAt) return true;
  return new Date(allocation.expiresAt).getTime() > now.getTime();
}

function allocationIncludesChat(allocation, chatId) {
  const key = String(chatId);
  const items = Array.isArray(allocation?.items) ? allocation.items : [];
  if (items.length) return items.some((item) => String(item.chatId) === key);
  return String(allocation?.chatId) === key;
}

function pruneExpiredCartAllocations(allocations, now = new Date()) {
  const next = {};
  for (const [key, allocation] of Object.entries(allocations || {})) {
    if (allocationIsActive(allocation, now)) {
      next[key] = allocation;
    }
  }
  return next;
}

export async function allocateAutoCarts({ allocationCandidates, nextState }) {
  const assignedKeys = new Set();
  const assignedAllocationKeys = new Set();
  const failedAllocationKeys = new Set();
  if (!autoCartEnabled() || !telegramIsConfigured() || !allocationCandidates.length) {
    return { assignedKeys, assignedAllocationKeys, failedAllocationKeys };
  }

  const allocations = pruneExpiredCartAllocations(nextState[CART_ALLOCATIONS_KEY] || {});

  for (const { key, winners } of selectAutoCartWinners(allocationCandidates, allocations)) {
    for (const winner of winners) {
      const option = winner.summary.cartOption;
      let cart;

      try {
        cart = await createSingleMatchCart({
          performanceId: winner.summary.performanceId,
          option,
          quantity: winner.cartQuantity || 1
        });
        cart = { ...cart, SelectedQuantity: winner.cartQuantity || 1 };

        const now = new Date();
        const expiresAt = new Date(now.getTime() + CART_EXPIRY_MINUTES * 60 * 1000);
        const item = {
          chatId: String(winner.chatId),
          priority: userPriority(winner.chatState),
          quantity: winner.cartQuantity || 1,
          orderId: cart.OrderId,
          checkoutRedirectUrl: cart.CheckoutRedirectUrl,
          allocatedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          notifiedAt: null,
          error: null
        };
        const previousItems = Array.isArray(allocations[key]?.items)
          ? allocations[key].items
          : [];

        allocations[key] = {
          active: true,
          allocationKey: key,
          chatId: previousItems.length ? allocations[key]?.chatId : String(winner.chatId),
          priority: previousItems.length ? allocations[key]?.priority : userPriority(winner.chatState),
          match: winner.summary.match,
          teams: winner.summary.teams,
          sectionCode: option.sectionCode,
          sectionName: option.sectionName,
          amount: option.amount,
          orderId: previousItems.length ? allocations[key]?.orderId : cart.OrderId,
          checkoutRedirectUrl: previousItems.length ? allocations[key]?.checkoutRedirectUrl : cart.CheckoutRedirectUrl,
          allocatedAt: previousItems.length ? allocations[key]?.allocatedAt : item.allocatedAt,
          expiresAt: previousItems.length ? allocations[key]?.expiresAt : item.expiresAt,
          notifiedAt: previousItems.length ? allocations[key]?.notifiedAt : null,
          error: null,
          items: [...previousItems, item]
        };

        await sendTelegramMessage(formatAutoCartMessage({ summary: winner.summary, option, cart }), {
          chatId: winner.chatId,
          replyMarkup: mainMenuKeyboard()
        });

        if (shouldNotifyAdminCartAssignment({ chatId: winner.chatId, summary: winner.summary, option })) {
          for (const adminChatId of adminCartNotifyChatIds()) {
            if (String(adminChatId) === String(winner.chatId)) continue;
            await sendTelegramMessage(formatAdminAutoCartNotification({
              summary: winner.summary,
              option,
              winnerChatId: winner.chatId,
              cart
            }), {
              chatId: adminChatId,
              replyMarkup: mainMenuKeyboard()
            });
          }
        }

        allocations[key] = {
          ...allocations[key],
          items: allocations[key].items.map((currentItem) => (
            currentItem === item
              ? { ...currentItem, notifiedAt: new Date().toISOString() }
              : currentItem
          )),
          notifiedAt: allocations[key].notifiedAt || new Date().toISOString()
        };
        assignedKeys.add(`${winner.chatId}:${key}`);
        assignedAllocationKeys.add(key);
        console.log(`Auto cart assigned: ${key} to chat ${winner.chatId}`);
      } catch (error) {
        allocations[key] = allocations[key] || {
          active: true,
          allocationKey: key,
          chatId: String(winner.chatId),
          priority: userPriority(winner.chatState),
          match: winner.summary.match,
          teams: winner.summary.teams,
          sectionCode: option.sectionCode,
          sectionName: option.sectionName,
          amount: option.amount,
          allocatedAt: new Date().toISOString(),
          notifiedAt: null,
          items: []
        };
        allocations[key] = {
          ...allocations[key],
          checkoutRedirectUrl: allocations[key].checkoutRedirectUrl || cart?.CheckoutRedirectUrl,
          orderId: allocations[key].orderId || cart?.OrderId,
          error: error.message
        };
        failedAllocationKeys.add(key);
        console.error(`[${new Date().toISOString()}] Auto cart failed for ${key}: ${error.message}`);
        break;
      }
    }
  }

  nextState[CART_ALLOCATIONS_KEY] = allocations;
  return { assignedKeys, assignedAllocationKeys, failedAllocationKeys };
}

async function checkSubscriptions() {
  const subscriptionsState = normalizeSubscriptionState(await readState(SUBSCRIPTIONS_FILE));
  const chatEntries = Object.entries(subscriptionsState.chats || {});
  if (!chatEntries.length) return;

  const matches = await fetchSingleMatchInventory();
  const state = await readState(DEFAULT_STATE_FILE);
  const nextState = { ...state };
  const allocations = pruneExpiredCartAllocations(state[CART_ALLOCATIONS_KEY] || {});
  const allocationCandidates = [];
  const manualAlertCandidates = [];
  const activeAllocationKeys = new Set();
  let checkedCount = 0;

  for (const [chatId, chatState] of chatEntries) {
    const subscriptions = Array.isArray(chatState.subscriptions) ? chatState.subscriptions : DEFAULT_SUBSCRIPTIONS;

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

      if (summary.isAvailable && summary.selectedSectionCode && autoCartAllowedForMatch(summary.match)) {
        const allocationKey = cartAllocationKey(summary);
        activeAllocationKeys.add(allocationKey);
        allocationCandidates.push({ chatId, chatState, subscription, summary });
      }

      if (becameAvailable || firstSeenAvailable) {
        manualAlertCandidates.push({ chatId, subscription, summary });
      }

      nextState[key] = {
        isAvailable: summary.isAvailable,
        minAvailablePrice: summary.minAvailablePrice,
        cheapestSelectedPrice: summary.cheapestSelectedPrice,
        selectedSection: summary.selectedSection,
        selectedSectionCode: summary.selectedSectionCode,
        availableQuantity: summary.availableQuantity,
        isOffered: summary.isOffered,
        error: null,
        checkedAt: new Date().toISOString()
      };
    }
  }

  for (const key of Object.keys(allocations)) {
    if (!activeAllocationKeys.has(key)) {
      delete allocations[key];
    }
  }
  nextState[CART_ALLOCATIONS_KEY] = allocations;

  await recordAvailabilityEvents(matches, nextState);

  const {
    assignedKeys: autoAssignedKeys,
    assignedAllocationKeys,
    failedAllocationKeys
  } = await allocateAutoCarts({
    allocationCandidates,
    nextState
  });

  if (telegramIsConfigured()) {
    for (const candidate of manualAlertCandidates) {
      const allocationKey = candidate.summary.selectedSectionCode
        ? cartAllocationKey(candidate.summary)
        : null;
      const autoAssignedKey = allocationKey ? `${candidate.chatId}:${allocationKey}` : null;
      if (
        allocationKey &&
        failedAllocationKeys.has(allocationKey) &&
        !assignedAllocationKeys.has(allocationKey)
      ) continue;
      if (autoAssignedKey && autoAssignedKeys.has(autoAssignedKey)) continue;
      const activeAllocation = allocationKey ? nextState[CART_ALLOCATIONS_KEY]?.[allocationKey] : null;
      const assignedToAnotherUser = Boolean(
        autoCartEnabled() &&
        allocationKey &&
        activeAllocation &&
        allocationIsActive(activeAllocation) &&
        !allocationIncludesChat(activeAllocation, candidate.chatId)
      );

      await sendTelegramMessage(formatTelegramAlertForSubscription(candidate.summary, candidate.subscription, {
        autoCartAssignedToAnotherUser: assignedToAnotherUser
      }), {
        chatId: candidate.chatId,
        replyMarkup: matchUrlKeyboard(candidate.summary)
      });
      console.log(`Telegram sent: ${candidate.summary.match} to chat ${candidate.chatId}`);
    }
  }

  await writeState(DEFAULT_STATE_FILE, nextState);

  console.log(`[${new Date().toISOString()}] Checked ${checkedCount} saved alert(s) for ${chatEntries.length} chat(s)`);
}

async function buildPricesMessage(matchInput) {
  const matchNumber = normalizeMatchInput(matchInput);
  if (!matchNumber) return "Uso: /precios M104";

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

async function createCartMessage(matchInput, sectionCode) {
  const matchNumber = normalizeMatchInput(matchInput);
  if (!matchNumber || !sectionCode) return "No pude identificar el partido/sección para crear el carrito.";

  const match = filterMatches(await fetchSingleMatchInventory(), { match: matchNumber })[0];
  if (!match) return `No encontré ${matchNumber}.`;

  const lounges = await fetchSingleMatchLounges(match.PerformanceId);
  const hospitalityOptions = getHospitalityOptions(lounges, { sectionCode });
  const option = hospitalityOptions.find((item) => item.isAvailable);

  if (!option) {
    return [
      `No pude crear carrito para ${matchNumber}.`,
      "",
      "FIFA ya no muestra esa sección como disponible. Probá con /precios para ver qué queda."
    ].join("\n");
  }

  const cart = await createSingleMatchCart({
    performanceId: match.PerformanceId,
    option,
    quantity: 1
  });

  return [
    "Carrito FIFA creado",
    "",
    `${matchNumber} ${match.HostTeam?.ExternalName || "TBD"} vs ${match.OpposingTeam?.ExternalName || "TBD"}`,
    `${option.sectionName}: ${formatMoney(option.amount)} x 1`,
    `Total: ${formatMoney(cart.SelectionTotalAmount)}`,
    "",
    cart.CheckoutRedirectUrl,
    "",
    "Ese link abre el carrito oficial. No hice checkout ni pago."
  ].join("\n");
}

function helpMessage() {
  return [
    "Comandos disponibles:",
    "",
    "También podés usar los botones de abajo para configurar tus alertas.",
    "",
    "/seguir M104 barata",
    "/seguir M104 all",
    "/precios M104",
    "/prioridades",
    "/prioridad <chatId> <numero>",
    "/lista",
    "/menu",
    "/estado",
    "/quitar M104",
    "/reiniciar",
    "/start",
    "",
    "Categorías útiles: barata, Suite Essentials, VIP, Pitchside, Trophy, Champions, FIFA Pavilion, all.",
    "Podés usar cualquier partido del M1 al M104. Ejemplo: /seguir M75 barata.",
    "",
    "Este bot no es oficial de FIFA. Puede crear un link de carrito cuando tocás el botón, o automáticamente si AUTO_CART_ENABLED=true, pero no hace checkout ni compra entradas.",
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
  const changedSubscriptionChats = new Set();
  let botStateDirty = false;
  let subscriptionsDirty = false;

  const markSubscriptionsDirty = (chatId) => {
    subscriptionsDirty = true;
    changedSubscriptionChats.add(String(chatId));
  };

  for (const update of updates.result || []) {
    nextState.offset = update.update_id + 1;
    botStateDirty = true;

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
        setChatSubscriptions(subscriptionsState, chatId, RESET_SUBSCRIPTIONS);
        markSubscriptionsDirty(chatId);
        await sendTelegramMessage("Listo. Reinicié tus alertas y dejé M104 baratas.", {
          chatId,
          replyMarkup: mainMenuKeyboard()
        });
        continue;
      }

      if (data.startsWith("cart:")) {
        const [, matchInput, sectionCode] = data.split(":");
        await safelySendChatAction(chatId);
        try {
          await sendTelegramMessage(await createCartMessage(matchInput, sectionCode), {
            chatId,
            replyMarkup: mainMenuKeyboard()
          });
        } catch (error) {
          await sendTelegramMessage([
            "No pude crear el carrito en FIFA.",
            "",
            error.message,
            "",
            "Probá abrir FIFA manualmente desde la alerta o revisá /precios."
          ].join("\n"), {
            chatId,
            replyMarkup: mainMenuKeyboard()
          });
        }
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
        botStateDirty = true;
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
        markSubscriptionsDirty(chatId);
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
        botStateDirty = true;
        const section = normalizeSectionInput(sectionInput);
        const scope = section.cheapestPerCategory
          ? "la entrada más barata de cada categoría"
          : section.allSections ? "todas las categorías" : section.section || DEFAULT_SECTION;
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
        botStateDirty = true;
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
          markSubscriptionsDirty(chatId);
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
      const currentChatState = subscriptionsState.chats?.[String(chatId)];
      if (!currentChatState || !Array.isArray(currentChatState.subscriptions)) {
        setChatSubscriptions(subscriptionsState, chatId, DEFAULT_SUBSCRIPTIONS);
        markSubscriptionsDirty(chatId);
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

    if (command === "/priorities" || command === "/prioridades") {
      if (!isAdminChat(chatId)) {
        await sendTelegramMessage("Ese comando es sólo para admin.", { chatId });
        continue;
      }

      await sendTelegramMessage(prioritiesMessage(subscriptionsState), {
        chatId,
        replyMarkup: mainMenuKeyboard()
      });
      continue;
    }

    if (command === "/priority" || command === "/prioridad") {
      if (!isAdminChat(chatId)) {
        await sendTelegramMessage("Ese comando es sólo para admin.", { chatId });
        continue;
      }

      const [, targetChatId, rawPriority] = text.split(/\s+/);
      const priority = Number(rawPriority);
      if (!targetChatId || !Number.isFinite(priority)) {
        await sendTelegramMessage("Uso: /prioridad <chatId> <numero>", { chatId });
        continue;
      }

      setUserPriority(subscriptionsState, targetChatId, priority);
      markSubscriptionsDirty(targetChatId);
      await sendTelegramMessage(`Listo. Prioridad de ${targetChatId}: ${priority}`, {
        chatId,
        replyMarkup: mainMenuKeyboard()
      });
      continue;
    }

    if (command === "/watch" || command === "/seguir") {
      const subscription = parseWatchCommand(text);
      if (!subscription || !isValidMatchNumber(subscription.match)) {
        await sendTelegramMessage("Uso: /seguir M104 barata, /seguir M104 all o /seguir M104 Supporters", { chatId });
        continue;
      }

      addSubscription(subscriptionsState, chatId, subscription);
      markSubscriptionsDirty(chatId);
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
        await sendTelegramMessage("Uso: /quitar M104", { chatId });
        continue;
      }

      const current = getChatSubscriptions(subscriptionsState, chatId);
      const next = current.filter((subscription) => subscription.match !== match);
      setChatSubscriptions(subscriptionsState, chatId, next);
      markSubscriptionsDirty(chatId);
      await sendTelegramMessage(`Listo. Quité las alertas de ${match}.`, {
        chatId,
        replyMarkup: mainMenuKeyboard()
      });
      continue;
    }

    if (command === "/reset" || command === "/reiniciar") {
      setChatSubscriptions(subscriptionsState, chatId, RESET_SUBSCRIPTIONS);
      markSubscriptionsDirty(chatId);
      await sendTelegramMessage("Listo. Reinicié tus alertas y dejé M104 baratas.", {
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
    botStateDirty = false;
    if (subscriptionsDirty) {
      await writeSubscriptionsState(subscriptionsState, changedSubscriptionChats);
      subscriptionsDirty = false;
      changedSubscriptionChats.clear();
    }

    await safelySendChatAction(chatId);
    await sendTelegramMessage(await buildWelcomePricesMessage(), {
      chatId,
      replyMarkup: mainMenuKeyboard()
    });
  }

  if (botStateDirty) {
    await writeState(TELEGRAM_BOT_STATE_FILE, nextState);
  }
  if (subscriptionsDirty) {
    await writeSubscriptionsState(subscriptionsState, changedSubscriptionChats);
  }
}

function installShutdownHandlers() {
  const shutdown = (signal) => {
    console.log(`[${new Date().toISOString()}] Received ${signal}; exiting cleanly`);
    process.exit(0);
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

async function main() {
  await loadDotEnv();
  installShutdownHandlers();

  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  console.log(`[${new Date().toISOString()}] State backend: ${stateBackend()}`);

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

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
