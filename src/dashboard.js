import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_PORT = 8787;
const RUNTIME_STATE_DIR = "/Users/matiasmassetti/.fifa-hospitality-monitor/.state";
const LOCAL_STATE_DIR = resolve(".state");

const port = Number(process.env.PORT || process.env.DASHBOARD_PORT || DEFAULT_PORT);
const stateDir = process.env.DASHBOARD_STATE_DIR
  || (existsSync(RUNTIME_STATE_DIR) ? RUNTIME_STATE_DIR : LOCAL_STATE_DIR);
const DEFAULT_SUBSCRIPTIONS = [
  { match: "M86", allSections: true },
  { match: "M95", allSections: true },
  { match: "M100", allSections: true }
];

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function subscriptionScope(subscription) {
  if (subscription.allSections) return "all";
  return subscription.sectionCode || subscription.section || "Suite Essentials";
}

function subscriptionLabel(subscription) {
  if (subscription.allSections) return "todas las categorias";
  return subscription.section || subscription.sectionCode || "Suite Essentials";
}

function stateKey(chatId, subscription) {
  return `${chatId}:${subscription.match}:${subscriptionScope(subscription)}`;
}

function formatMoney(amount) {
  if (amount == null) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(amount);
}

function userName(chatId, user = {}) {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ");
  if (user.username) return `@${user.username}`;
  if (fullName) return fullName;
  if (user.chatTitle) return user.chatTitle;
  return `Chat ${chatId}`;
}

function availabilityLabel(state) {
  if (!state) return "Sin chequeo";
  if (state.error) return "Error FIFA";
  if (state.isAvailable) return "Disponible";
  if (state.isOffered === false) return "No ofrecida";
  return "Sin disponibilidad";
}

function latestDate(values) {
  return values
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

async function buildDashboardData() {
  const subscriptionsState = await readJson(join(stateDir, "subscriptions.json"), { chats: {} });
  const usersState = await readJson(join(stateDir, "users.json"), { chats: {} });
  const monitorState = await readJson(join(stateDir, "hospitality-monitor.json"), {});
  const chats = Object.entries(subscriptionsState.chats || {});
  const users = chats.map(([chatId, chatState]) => {
    const user = chatState.user || usersState.chats?.[chatId]?.user || {};
    const subscriptions = chatState.subscriptions?.length
      ? chatState.subscriptions
      : DEFAULT_SUBSCRIPTIONS;
    const alerts = subscriptions.map((subscription) => {
      const lastState = monitorState[stateKey(chatId, subscription)];
      return {
        match: subscription.match,
        category: subscriptionLabel(subscription),
        allSections: Boolean(subscription.allSections),
        status: availabilityLabel(lastState),
        isAvailable: Boolean(lastState?.isAvailable),
        price: formatMoney(lastState?.minAvailablePrice ?? lastState?.cheapestSelectedPrice),
        checkedAt: lastState?.checkedAt || null,
        error: lastState?.error || null
      };
    });

    return {
      chatId,
      name: userName(chatId, user),
      username: user.username || null,
      priority: Number(user.priority ?? chatState.priority ?? 0) || 0,
      chatType: user.chatType || null,
      firstSeenAt: user.firstSeenAt || null,
      lastSeenAt: user.lastSeenAt || null,
      alertCount: alerts.length,
      alerts
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    stateDir,
    userCount: users.length,
    alertCount: users.reduce((total, user) => total + user.alertCount, 0),
    lastCheckAt: latestDate(Object.values(monitorState).map((entry) => entry?.checkedAt)),
    users
  };
}

function htmlPage() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hospitality Bot Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #17202a;
      --muted: #687385;
      --border: #dfe4ec;
      --ok: #087f5b;
      --warn: #9a3412;
      --quiet: #546179;
      --accent: #133c7c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      padding: 24px 28px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--panel);
    }
    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1.2;
    }
    .subhead {
      margin-top: 6px;
      color: var(--muted);
      font-size: 14px;
    }
    main {
      padding: 24px 28px;
      max-width: 1180px;
      margin: 0 auto;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .stat, .user {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .stat {
      padding: 16px;
    }
    .stat span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .stat strong {
      display: block;
      margin-top: 6px;
      font-size: 22px;
    }
    .toolbar {
      display: flex;
      gap: 12px;
      align-items: center;
      margin: 18px 0;
    }
    input {
      width: 100%;
      max-width: 420px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 14px;
      background: #fff;
    }
    button {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      background: #fff;
      cursor: pointer;
      font-size: 14px;
    }
    .users {
      display: grid;
      gap: 12px;
    }
    .user {
      overflow: hidden;
    }
    .user-header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 16px;
      border-bottom: 1px solid var(--border);
      background: #fbfcfe;
    }
    .user-name {
      font-weight: 700;
      font-size: 16px;
    }
    .meta {
      color: var(--muted);
      font-size: 13px;
      margin-top: 4px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      height: 24px;
      padding: 0 8px;
      border-radius: 999px;
      background: #edf2ff;
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      font-size: 14px;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .04em;
      background: #fff;
    }
    tr:last-child td {
      border-bottom: 0;
    }
    .status {
      font-weight: 700;
    }
    .status.ok { color: var(--ok); }
    .status.warn { color: var(--warn); }
    .status.quiet { color: var(--quiet); }
    .empty {
      padding: 32px;
      text-align: center;
      color: var(--muted);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    @media (max-width: 760px) {
      header, main { padding-left: 16px; padding-right: 16px; }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .user-header { display: block; }
      .badge { margin-top: 10px; }
      th:nth-child(4), td:nth-child(4) { display: none; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Hospitality Bot Dashboard</h1>
    <div class="subhead">Usuarios, alertas configuradas y último estado conocido.</div>
  </header>
  <main>
    <section class="stats" id="stats"></section>
    <div class="toolbar">
      <input id="search" placeholder="Buscar por usuario, chat ID, partido o categoría">
      <button id="refresh">Actualizar</button>
    </div>
    <section class="users" id="users"></section>
  </main>
  <script>
    let latestData = null;

    function formatDate(value) {
      if (!value) return "-";
      return new Date(value).toLocaleString("es-AR");
    }

    function statusClass(status) {
      if (status === "Disponible") return "ok";
      if (status === "No ofrecida" || status === "Error FIFA") return "warn";
      return "quiet";
    }

    function renderStats(data) {
      document.getElementById("stats").innerHTML = [
        ["Usuarios", data.userCount],
        ["Alertas", data.alertCount],
        ["Ultimo chequeo", formatDate(data.lastCheckAt)],
        ["Actualizado", formatDate(data.generatedAt)]
      ].map(([label, value]) => '<article class="stat"><span>' + label + '</span><strong>' + value + '</strong></article>').join("");
    }

    function userMatchesQuery(user, query) {
      if (!query) return true;
      const text = [
        user.chatId,
        user.name,
        user.username,
        String(user.priority),
        user.chatType,
        ...user.alerts.flatMap((alert) => [alert.match, alert.category, alert.status])
      ].filter(Boolean).join(" ").toLowerCase();
      return text.includes(query.toLowerCase());
    }

    function renderUsers(data) {
      const query = document.getElementById("search").value.trim();
      const users = data.users.filter((user) => userMatchesQuery(user, query));
      const root = document.getElementById("users");

      if (!users.length) {
        root.innerHTML = '<div class="empty">No hay usuarios para mostrar.</div>';
        return;
      }

      root.innerHTML = users.map((user) => {
        const rows = user.alerts.map((alert) => {
          return '<tr>'
            + '<td><strong>' + alert.match + '</strong></td>'
            + '<td>' + alert.category + '</td>'
            + '<td class="status ' + statusClass(alert.status) + '">' + alert.status + '</td>'
            + '<td>' + (alert.price || '-') + '</td>'
            + '<td>' + formatDate(alert.checkedAt) + '</td>'
            + '</tr>';
        }).join("");

        return '<article class="user">'
          + '<div class="user-header">'
          + '<div><div class="user-name">' + user.name + '</div>'
          + '<div class="meta">Chat ID: ' + user.chatId + ' · Prioridad: ' + user.priority + ' · Última actividad: ' + formatDate(user.lastSeenAt) + '</div></div>'
          + '<span class="badge">' + user.alertCount + ' alertas · P' + user.priority + '</span>'
          + '</div>'
          + '<table><thead><tr><th>Partido</th><th>Categoría</th><th>Estado</th><th>Precio</th><th>Chequeado</th></tr></thead><tbody>'
          + rows
          + '</tbody></table>'
          + '</article>';
      }).join("");
    }

    async function load() {
      const response = await fetch("/api/dashboard");
      latestData = await response.json();
      renderStats(latestData);
      renderUsers(latestData);
    }

    document.getElementById("refresh").addEventListener("click", load);
    document.getElementById("search").addEventListener("input", () => latestData && renderUsers(latestData));
    load();
    setInterval(load, 15000);
  </script>
</body>
</html>`;
}

function sendJson(response, data) {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(data));
}

function sendHtml(response, body) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname === "/api/dashboard") {
      sendJson(response, await buildDashboardData());
      return;
    }

    if (url.pathname === "/" || url.pathname === "/dashboard") {
      sendHtml(response, htmlPage());
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error.stack || error.message);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Dashboard running at http://127.0.0.1:${port}`);
  console.log(`Reading state from ${stateDir}`);
});
