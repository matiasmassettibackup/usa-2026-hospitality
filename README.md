# FIFA Hospitality Availability Monitor

Bot local para monitorear disponibilidad de FIFA Hospitality 2026, avisar por Telegram y abrir el flujo oficial de compra.

La página de FIFA Hospitality carga una app Next.js y usa este endpoint interno para single matches:

```text
https://fifaworldcup26.hospitality.fifa.com/next-api/matches-all?productCode=26FWC&productType=5
```

Ese endpoint sirve para saber qué partidos existen y si hay alguna categoría disponible. Para conocer la sección exacta disponible, el monitor usa una segunda llamada:

```text
https://fifaworldcup26.hospitality.fifa.com/next-api/lounges?productCode=26FWC&productTypeCode=SM&quantity=1&performanceId=...
```

La señal útil de disponibilidad está en:

- `seatingSections[].IsAvailable === true`
- `seatingSections[].AvailableQuantity > 0`

Cuando una alerta usa `all`, el bot consulta también lounges/secciones y elige una sección realmente disponible, no sólo el precio "desde" del match.

El monitor escucha por defecto:

- `M86` - Argentina vs Cabo Verde, Miami Stadium
- `M95`
- `M100`

## Comandos

Chequeo puntual de M86, M95 y M100, por defecto en todas las categorías:

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
node src/monitor.js --once --match M86
node src/monitor.js --once --match M86,M95,M100 --all-sections
node src/monitor.js --match M86 --all-sections --interval 30
node src/monitor.js --once --venue NN_DAL
node src/monitor.js --once --team Argentina
node src/monitor.js --once --match M100 --all-sections
node src/monitor.js --once --match M86 --section "VIP Lounge"
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
AUTO_CART_ENABLED=false
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

Las alertas incluyen la sección exacta y cantidad disponible si FIFA la informa. El botón `Crear carrito` vuelve a validar disponibilidad y, si la sección sigue disponible, crea una orden en FIFA y responde con el link oficial de carrito. El botón `Abrir FIFA manual` queda como fallback.

Si `AUTO_CART_ENABLED=true`, el monitor puede crear el carrito automáticamente cuando detecta disponibilidad en una alerta guardada. Por seguridad viene apagado por defecto. Con el auto-carrito activo:

- se crea sólo un carrito por evento de disponibilidad y sección;
- gana el usuario que esté escuchando ese partido/sección con mayor prioridad global;
- las alertas `all` participan para cualquier sección disponible del partido;
- los usuarios no ganadores reciben la alerta normal, pero no un carrito prearmado;
- el link abre el carrito oficial de FIFA, pero el bot no hace checkout ni pago.

El bot también responde `/start` con una bienvenida en español. Si existe `assets/la-banda-argentina.jpg`, la manda como foto junto al mensaje.

Comandos disponibles para usuarios:

```text
/seguir M86 all
/seguir M95 all
/seguir M100 all
/seguir M86 VIP
/precios M86
/prioridades
/prioridad <chatId> <numero>
/lista
/quitar M100
/reiniciar
/ayuda
```

`/prioridad` y `/prioridades` son comandos admin. Por defecto el admin es `TELEGRAM_CHAT_ID`; se puede configurar una lista separada con `ADMIN_CHAT_IDS=123,456`.

Las preferencias se guardan localmente por chat en:

```text
/Users/matiasmassetti/.fifa-hospitality-monitor/.state/subscriptions.json
```

## Carrito FIFA

La web crea carrito/orden sin login con este endpoint interno:

```text
POST https://fifaworldcup26.hospitality.fifa.com/next-api/orders
```

Headers mínimos observados:

```text
Content-Type: application/json
country-tag: us
language-tag: en
```

Payload para single match:

```json
{
  "ProductType": 5,
  "ProductCode": "26FWC",
  "OrderId": 0,
  "PartnerId": "",
  "SelectedQuantity": 1,
  "PackageSelectionData": {
    "SeatCategoryId": 10229236268047,
    "AudienceSubCategoryId": 10229206883474,
    "InstitutionSeatCategoryId": 10229203839377,
    "PackageLineId": 0,
    "PerformanceId": 10229203824844
  }
}
```

El ejemplo anterior corresponde a M86, `FIFA Pavilion`, qty 1 al momento de investigarlo. Los IDs deben salir siempre de los endpoints vivos de `matches-all` y `lounges`; no deben hardcodearse para producción.

La respuesta devuelve `OrderId`, `OrderSecretId`, `SelectionTotalAmount`, `TransactionDetails` y `CheckoutRedirectUrl`. Crear la orden no hace checkout ni pago. El checkout empieza recién al abrir `CheckoutRedirectUrl`.

En Telegram, el bot sólo llama automáticamente a `/next-api/orders` cuando `AUTO_CART_ENABLED=true`. Si está apagado, sólo crea órdenes cuando el usuario toca `Crear carrito` en la alerta.

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
