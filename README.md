# Quedamos

PWA para cuadrar horas entre varias personas. Una persona crea la quedada y pasa **un enlace** por WhatsApp. Cada persona lo abre una vez, elige nombre y color, marca sus horas libres directamente en una rejilla de horas (7 días a la vista, 30 días en total) y pulsa **Enviar**. Su horario llega solo a todos los demás y queda guardado en el móvil de cada uno. Nadie tiene que volver a abrir enlaces. Si coincidís todos en una hora, esa franja brilla.

Sin backend propio, sin base de datos que mantener, sin registros.

## Cómo funciona la sincronización

- **Enlace**: `index.html#<datos>`. Los datos (base64url) llevan la versión, un id de sesión aleatorio, una clave secreta de 32 bytes, el título, el nº de personas, el rango horario y la fecha de inicio. La parte tras `#` nunca se envía a ningún servidor, así que la sesión se abre al instante incluso sin red.
- **Copia permanente**: en cada móvil, en IndexedDB (si no se puede, localStorage; si tampoco, memoria con aviso). Se guardan los eventos firmados originales de cada participante.
- **Transporte**: relés públicos de Nostr (NIP-01 sobre WebSocket) usados como buzón. Se publica en todos y se lee de todos; basta con que funcione uno. La lista está en `public/core.js` (`RELAYS`).
- **Cifrado**: AES-256-GCM con clave derivada por HKDF-SHA256 (`quedamos-enc`), IV aleatorio por mensaje. El relé solo ve datos cifrados y un tag de búsqueda (`t` = HMAC-SHA256 con clave derivada `quedamos-topic` sobre el id de sesión, 32 hex). Nada en claro revela nombres, títulos ni horarios.
- **Eventos**: kind `30078` (NIP-78, reemplazable con parámetro), `d = <topic>:<participantId>`. Cada móvil genera su par de claves secp256k1 al unirse (la privada no sale del móvil) y firma con Schnorr BIP-340. El `participantId` son los 16 primeros hex de la clave pública.
- **Seguridad**: se descartan sin procesar los mensajes de más de 32 KB y los contenidos de más de 4 KB (un horario cifrado ocupa unos cientos de bytes); se verifican id y firma de todo lo recibido, sin recordar rechazos por id (una copia falsa no bloquea la auténtica que traiga otro relé); la primera clave vista para un participante queda fijada; lo que no se descifra se ignora; un evento viejo nunca pisa uno nuevo (gana `updatedAt`, luego `created_at`, luego el id menor).
- **Recepción**: al abrir, se pide todo lo del tag a todos los relés y se mantiene la suscripción mientras la app está visible. Tras 30 s en segundo plano se cierran las conexiones; al volver se reconecta y se repite la consulta completa. Se descartó pedir solo desde el último `created_at` visto (lo que proponía la especificación): un envío que estuvo en cola sin red conserva su `created_at` antiguo y un móvil con el reloj adelantado haría saltar ese punto al futuro; en ambos casos se perdían eventos. Con un evento reemplazable por persona (máximo 20) la consulta completa es barata. Reconexión con espera exponencial.
- **Envío**: botón **Enviar** con estados "Cambios sin enviar", "Enviando…", "Enviado" (cuando al menos un relé responde `OK true`) y "Sin conexión: se enviará al volver" (cola guardada y reintento automático). Si sales con cambios sin enviar, al volver aparece el aviso. Lo que quede en cola en una quedada que no está abierta se intenta enviar en segundo plano al abrir el inicio o al volver la red, y el inicio marca las quedadas con cambios sin enviar.
- **Gossip**: cada móvil, al abrir la sesión, vuelve a publicar tal cual (mismas firmas) los eventos que tiene guardados y que un relé no devuelve. Una sola vez por apertura y con límite, así que no hay bucles. Si un relé borra datos viejos, se restauran desde los móviles.
- **Recuperar identidad**: en Ajustes, "Copiar mi enlace personal" (el enlace de la sesión con tu clave privada). Sirve para recuperar tu identidad si cambias de móvil o borras datos. No se comparte: quien lo tenga puede escribir en tu nombre. Sin ese enlace, quien borre los datos o quite la quedada y vuelva a entrar aparece como otra persona (la antigua sigue contando para el brillo).
- **iPhone instalada**: la app añadida a la pantalla de inicio no comparte datos con Safari. No se invita a instalarla. En la app instalada el inicio muestra arriba "Abrir un enlace" (si aún no tiene quedadas, con una línea que explica que debe pegar su enlace personal de Safari para seguir siendo la misma persona), y la pantalla de unirse lo recuerda. En Safari, Ajustes lo avisa.
- **Navegador dentro de WhatsApp/Instagram/Facebook o WebView de Android**: funciona igual (sin service worker si no lo hay; copiar enlaces con alternativa a `execCommand`). Como guarda sus datos aparte, la pantalla de unirse y Ajustes avisan de copiar el enlace personal antes de pasar a otro navegador. En iPhone WhatsApp abre los enlaces en SFSafariViewController (datos aparte de Safari y sin marca en el UA), así que en iOS la pantalla de unirse muestra siempre una línea para guardar el enlace personal.

## La rejilla de horas

- Columnas = días (semana de lunes a domingo), filas = horas del rango. Se ven 7 días sin scroll horizontal desde 360 px; las semanas se cambian con ‹ › o con los puntos (un punto dorado indica que esa semana hay una hora en la que coincidís todos). Las ~5 semanas cubren los 30 días; los días fuera de la ventana salen huecos y los pasados, atenuados y no editables.
- **Marcar desde fuera**: tocar una celda la alterna; mantener y arrastrar pinta un rectángulo (como When2meet: si empiezas en una celda vacía, marca; si empiezas en una marcada, borra). No se abre nada al tocar.
- **Desplazamiento**: `touch-action: none` solo en las celdas, así al pintar la página no se mueve. Para subir o bajar se desliza sobre la columna de horas, la cabecera o los márgenes (lo explica una línea bajo la rejilla). La cabecera de días se queda fija al bajar.
- **Todo a la vista**: en cada celda, una franja vertical por persona disponible en su color, siempre en el mismo carril (yo primero, luego por nombre), así se siguen las horas de cada uno de un vistazo. Mis celdas llevan relleno y borde de mi color. Mapa de calor discreto según cuántos coinciden. Si coinciden todos, la celda es dorada con un brillo suave animado y las contiguas se unen en un bloque (sin animación con `prefers-reduced-motion`).
- Tocar el nombre de alguien en la leyenda resalta sus horas y atenúa el resto. "Mejores horas" salta a la semana y hace parpadear el bloque. "Repetir esta semana" copia mi patrón a las demás semanas (sin tocar días pasados) y "Borrar semana" la vacía; ambas con Deshacer.

### El límite honesto

Los relés públicos son un **buzón gratuito de terceros**, no un servicio contratado: pueden caerse, limitar o borrar datos antiguos. Por eso se usan varios a la vez y cada móvil guarda la copia permanente y la vuelve a publicar (gossip). Si **todos** los relés fallasen a la vez, los horarios no se perderían (siguen en cada móvil), pero los cambios nuevos no llegarían a los demás hasta que alguno vuelva. Para que alguien que entra muy tarde reciba todo, basta con que **un** relé conserve los datos o que **cualquier** móvil del grupo abra la quedada (y así los re-publique).

Quien tenga el enlace de la sesión puede leer y escribir en ella: tratadlo como el enlace de un grupo privado.

### Relés probados (16-11-2026, `scripts/live-test.mjs`, kind 30078)

| Relé | Publicar | Volver a leer |
|---|---|---|
| wss://nos.lol | OK | idéntico y descifrado |
| wss://relay.primal.net | OK | idéntico y descifrado |
| wss://nostr.mom | OK | idéntico y descifrado |
| wss://relay.snort.social | OK | idéntico y descifrado |
| wss://offchain.pub | OK | idéntico y descifrado |
| wss://relay.damus.io | 503 al conectar en ese momento (se mantiene; suele ser temporal) | — |
| wss://relay.nostr.band | no conectaba: retirado de la lista | — |

Ningún relé que conectase rechazó el kind 30078. Si cambias la lista en `core.js`, cambia también `connect-src` en la CSP de `public/index.html` (un test lo comprueba).

## Estructura

```
public/
  index.html            shell con CSP
  styles.css            estética glass, claro/oscuro, reduced-motion
  app.js                interfaz
  core.js               lógica pura: fechas, semanas, slots, bitmap, enlace, fusión, mejores bloques, coincidencia, validación
  crypto.js             HKDF, AES-GCM, HMAC, firma y verificación de eventos
  sync.js               relés, cola, gossip (transporte inyectable)
  store.js              IndexedDB -> localStorage -> memoria
  vendor/               @noble/secp256k1 3.1.0 (MIT), única dependencia
  manifest.webmanifest, sw.js, icons/
scripts/
  icons.mjs             genera los PNG (zlib, sin dependencias)
  serve.mjs             servidor estático local
  live-test.mjs         prueba real contra relés públicos
  bump-sw.mjs           VERSION del service worker = hash del shell
tests/                  node --test
```

## Probar en local

Requiere Node 22 o superior (se ha usado Node 24). No hay `npm install`: no hay dependencias.

```
npm test                      # o: node --test "tests/*.test.mjs"
node scripts/serve.mjs 8080   # abrir http://localhost:8080/
node scripts/live-test.mjs    # opcional: publica 1 evento ficticio cifrado y lo relee en cada relé
node scripts/icons.mjs        # regenerar iconos
```

Los tests cubren: fechas, semanas (paginación, repetir y borrar semana), slots y bitmap, enlace, validación, fusión, mejores bloques, coincidencia total, cifrado ida y vuelta, firma y verificación (vectores oficiales BIP-340 y serialización NIP-01), y `tests/sync.test.mjs`, que levanta un relé Nostr falso (servidor WebSocket propio sobre `node:http`) y tres "móviles" con almacenamiento en memoria: A crea; B y C se unen; C estaba desconectado y lo recibe todo al conectarse; los relés olvidan los datos y A, al abrir, los re-publica tal cual y un móvil nuevo de C los recupera; se ignoran firmas falsas, descifrados imposibles y suplantaciones; un evento viejo no pisa uno nuevo; la cola sin conexión se envía al volver la red; una copia falsificada no bloquea el evento auténtico; los eventos enormes se descartan; al volver de segundo plano llegan los envíos con `created_at` antiguo y los de relojes adelantados.

**Modo de prueba con relé local**: `?test-relay=ws://127.0.0.1:PUERTO` en la URL sustituye la lista de relés (solo acepta `ws://` a `127.0.0.1`/`localhost`). La CSP de `index.html` no permite `ws://`, así que en producción no tiene efecto; el arnés de capturas amplía la CSP solo en la copia que sirve al navegador de pruebas.

Para probar en el móvil dentro de la red local hace falta HTTPS (WebCrypto y el service worker lo exigen fuera de `localhost`); lo más sencillo es publicarlo en GitHub Pages.

## Publicar en GitHub Pages (pasos, no ejecutados)

1. Crear un repositorio en GitHub (por ejemplo `quedamos`) y subir este proyecto:
   ```
   git init
   git add public scripts tests README.md package.json .gitignore
   git commit -m "Quedamos"
   git branch -M main
   git remote add origin https://github.com/<usuario>/quedamos.git
   git push -u origin main
   ```
2. Publicar solo la carpeta `public/`. Dos opciones:
   - **GitHub Actions**: en *Settings → Pages → Source* elegir *GitHub Actions* y añadir `.github/workflows/pages.yml` con los pasos `actions/checkout`, `actions/upload-pages-artifact` (con `path: public`) y `actions/deploy-pages`.
   - **Rama `gh-pages`**: `git subtree push --prefix public origin gh-pages` y en *Settings → Pages* elegir la rama `gh-pages` y la carpeta `/ (root)`.
3. La app quedará en `https://<usuario>.github.io/quedamos/`. Todas las rutas son relativas, así que funciona en esa subruta.
4. Antes de publicar una versión nueva, ejecutar `node scripts/bump-sw.mjs`: pone en `VERSION` de `public/sw.js` el hash del shell y la app mostrará "Hay una versión nueva" con el botón Actualizar. `npm test` falla si se olvida.
