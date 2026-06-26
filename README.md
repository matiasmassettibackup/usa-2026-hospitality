# FIFA Hospitality Availability Monitor

Primer paso del bot: detectar disponibilidad sin Telegram todavía.

La página de FIFA Hospitality carga una app Next.js y usa este endpoint interno para single matches:

```text
https://fifaworldcup26.hospitality.fifa.com/next-api/matches-all?productCode=26FWC&productType=5
```

Ese endpoint sirve para saber qué partidos existen y si hay alguna categoría disponible. Para la categoría específica que nos importa por defecto, `Suite Essentials`, el monitor usa una segunda llamada:

```text
https://fifaworldcup26.hospitality.fifa.com/next-api/lounges?productCode=26FWC&productTypeCode=SM&quantity=1&performanceId=...
```

La señal útil para `Suite Essentials` está en:

- `seatingSections[].Name === "Suite Essentials"`
- `seatingSections[].IsAvailable === true`
- `seatingSections[].AvailableQuantity > 0`

En M70, `Suite Essentials` aparece como sección `MEL`, pero actualmente no disponible.

El monitor escucha por defecto:

- `M70` - Jordan vs Argentina, Dallas Stadium
- `M86` - Argentina vs 2H, Miami Stadium

## Comandos

Chequeo puntual de M70 y M86, por defecto sólo `Suite Essentials`:

```bash
npm run check
```

Monitoreo local cada 60 segundos:

```bash
npm run watch
```

Listar los partidos de Dallas, por defecto sólo `Suite Essentials`:

```bash
npm run list-dallas
```

Ejemplos directos:

```bash
node src/monitor.js --once --match M70
node src/monitor.js --once --match M70,M86
node src/monitor.js --match M70 --interval 30
node src/monitor.js --once --venue NN_DAL
node src/monitor.js --once --team Argentina
node src/monitor.js --once --match M70 --all-sections
node src/monitor.js --once --match M70 --section "VIP Lounge"
```

El monitor guarda estado en `.state/hospitality-monitor.json` para detectar el cambio `unavailable -> available` por sección y emitir `ALERT:`.

## Telegram

1. En Telegram, hablale a `@BotFather`.
2. Usá `/newbot`, elegí nombre/username, y copiá el token.
3. Abrí chat con tu bot y mandale cualquier mensaje, por ejemplo `hola`.
4. Creá `.env` usando [.env.example](.env.example):

```bash
TELEGRAM_BOT_TOKEN=123456789:replace_me
TELEGRAM_CHAT_ID=123456789
```

Para obtener tu `TELEGRAM_CHAT_ID` después de mandarle un mensaje al bot:

```bash
npm run telegram:updates
```

Para probar el envío:

```bash
npm run telegram:test
```

Cuando `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` están configurados, `npm run watch` manda Telegram automáticamente sólo cuando detecta que la sección monitoreada pasa a disponible.

El bot también responde `/start` con una bienvenida en español. Si existe `assets/la-banda-argentina.jpg`, la manda como foto junto al mensaje.

Comandos disponibles para usuarios:

```text
/seguir M70 Suite Essentials
/seguir M86 all
/seguir M86 VIP
/precios M86
/lista
/quitar M70
/reiniciar
/ayuda
```

Las preferencias se guardan localmente por chat en:

```text
/Users/matiasmassetti/.fifa-hospitality-monitor/.state/subscriptions.json
```

## Correr 24/7 en macOS

La opción gratuita/local es `launchd`, el supervisor nativo de macOS.

Para evitar restricciones de privacidad de macOS sobre carpetas como Desktop, el servicio corre desde esta copia runtime:

```text
/Users/matiasmassetti/.fifa-hospitality-monitor
```

La config fuente está en:

```text
launchd/com.matias.fifa-hospitality-monitor.plist
```

El servicio ejecuta:

```bash
scripts/run-monitor.sh
```

Comandos útiles después de instalarlo:

```bash
npm run service:status
npm run service:logs
npm run service:stop
npm run service:start
npm run service:sync
```

Los logs quedan en:

```text
/Users/matiasmassetti/.fifa-hospitality-monitor/.state/launchd.out.log
/Users/matiasmassetti/.fifa-hospitality-monitor/.state/launchd.err.log
```

Importante: si la Mac se duerme, el monitor se pausa. Para algo realmente 24/7, dejá activada una configuración de energía que evite el sleep automático.
