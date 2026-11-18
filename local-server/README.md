# Servidor local · enlace real PC ↔ celular

Hace que el celular y la PC de la tienda **se hablen de verdad por la red local** (antes la
sincronización era una simulación con `BroadcastChannel`, que solo comunica pestañas del mismo
navegador en el mismo aparato). También sirve la app por **HTTPS** y deja las librerías de la
página móvil **en local**, para que funcione **sin internet**.

No hay que tocar los componentes de Angular: `abarrotes-app/public/lan-sync-bridge.js` reemplaza
`BroadcastChannel('abarrotes_lan_sync')` por un WebSocket contra este servidor. Si el servidor no
está (por ejemplo con `ng serve`), todo sigue como antes.

## Uso (3 pasos)

```bash
# 1) compilar la app (una vez, y cada vez que cambie el código)
cd abarrotes-app && npm ci && npm run build

# 2) instalar el servidor (una vez)
cd ../local-server && pip install -r requirements.txt

# 3) arrancarlo
python -m lansync            # o doble clic en iniciar-servidor.bat (Windows) / iniciar-servidor.sh
```

Luego, en la PC, abre `https://localhost:8443/` y toca el botón **Móvil (QR)** en la barra superior: aparece un **código QR**. En el celular
(conectado al mismo Wi-Fi; no necesita internet) escanéalo con la cámara.

* La primera vez el navegador avisa que el certificado no es de confianza: toca **Avanzado → Continuar**.
  Es normal; el certificado lo crea esta misma PC (carpeta `certs/`).
* En Windows, la primera vez pedirá permitir Python en redes **privadas**: acepta.
* Si el celular no abre la página, revisa que ambos estén en la misma red y que el router no tenga
  activado el "aislamiento de clientes" (AP isolation). Alternativa: activar la zona Wi-Fi del
  celular y conectar la PC a ella.

## Cómo se protege

* Desde la propia PC (127.0.0.1) se confía sin código; **cualquier otro dispositivo necesita el
  código del QR** (primer mensaje `auth`, 5 s de plazo) o se le cierra la conexión.
* Se rechaza cualquier `Origin` que no sea el propio sitio (una página web abierta en la PC no puede
  usar el WebSocket de la tienda).
* Límite de 8 MB por mensaje y 60 mensajes por segundo por conexión.
* El código dura 30 días y **sobrevive reinicios** de la PC (se guarda en `data/pairing.json`) para no
  reescanear el QR cada mañana. El botón *Generar código nuevo* dentro del modal **Móvil (QR)** lo invalida y
  desconecta a todos los celulares.
* `certs/` y `data/` son secretos de cada tienda: están en `.gitignore`. No se suben a GitHub.
* **Evidencias fotográficas (`/api/evidencia`):** las fotos de merma se guardan en `data/evidencias/` con identificador aleatorio (UUID4 hex de 32 caracteres). **Las fotos solo se ven si la PC abre la app por localhost (`https://localhost:8443` o `127.0.0.1`)**, ya que el acceso sin token está restringido exclusivamente a loopback. Si la PC abre la app usando la IP de la red local, el servidor la tratará como un dispositivo externo y denegará la visualización (401) al no enviar token de vinculación.

## Pruebas

```bash
cd local-server
pip install -r requirements-dev.txt
python -m pytest -q                                              # servidor + prueba por red real (25)
cd tools && npm install && cd ..
NODE_TLS_REJECT_UNAUTHORIZED=0 node --test tests/bridge.test.mjs # puente contra el servidor real (6)
```

Las pruebas de red usan la IP de la red local de la máquina como si fuera un celular (el servidor la
ve como un dispositivo ajeno, que debe presentar el código).

## Librerías sin internet (`abarrotes-app/public/vendor/`)

Generadas, con **versión fija**, por `local-server/tools/build-vendor.mjs`:

```bash
cd local-server/tools && npm install && npm run build
```

Incluye html5-qrcode, Tesseract.js (script, worker, núcleo WASM y modelo en español) y el CSS
compilado de la página móvil. Pesa ~11 MB. Si prefieren no versionarlo, agreguen
`abarrotes-app/public/vendor/` al `.gitignore` y ejecuten el build en cada instalación.

## Para quien trabaje en la interfaz

El puente expone `window.LanSync`:

```js
LanSync.status      // 'idle' | 'unavailable' | 'connecting' | 'open' | 'closed' | 'unauthorized'
LanSync.phones      // celulares enlazados ahora mismo (en la PC)
LanSync.pc          // ¿hay PC conectada? (en el celular)
LanSync.on('peers', (s) => this.phoneLinked.set(s.phones > 0));   // reemplaza el "enlace" simulado
LanSync.on('status', (s) => { /* mostrar "sin conexión" en el celular */ });
```

Además dispara los eventos de ventana `lansync:status` y `lansync:peers`. Añade `?lanDebug=1` a la
dirección para ver una etiqueta con el estado.

Pendiente en la interfaz (no lo toqué para no pisar cambios del equipo):
* La etiqueta **"En Línea"** de la página móvil es fija y siempre verde: debería leer `LanSync.status`.
* El modal **Móvil (QR)** de la PC consume `GET /api/pairing`, `GET /api/pairing/qr.svg` y `POST /api/pairing/rotate` (solo responde desde la PC).

## Copia automática a USB (Bloque L)

El servidor copia **el respaldo `.bak` más reciente** a una memoria USB **una vez al día**. Solo copia el archivo
ya cifrado (AES-256-GCM): la frase de respaldo nunca llega al servidor para este fin ni se guarda en la USB.

```bash
python -m lansync                      # detecta solo las memorias USB extraíbles
python -m lansync --usb-dir E:\        # usa siempre esa unidad o carpeta (Windows)
python -m lansync --usb-dir /media/tienda/USB
python -m lansync --sin-usb            # desactiva la copia a USB
```

* La copia queda en la subcarpeta `BinniTech-Respaldos` de la unidad, con el mismo nombre `AAAAMMDD-HHMMSS.bak`.
  Se escribe primero a un archivo temporal, se verifica con SHA-256 contra el original y recién entonces se
  renombra: si sacan la USB a medias no queda un `.bak` incompleto.
* **Cuándo copia:** al terminar cada `POST /api/respaldo` (en segundo plano, sin hacer esperar al tendero) y
  cada 5 minutos revisa si conectaron una USB. Una vez al día por destino: si cambian de memoria USB el mismo
  día, copia a la nueva.
* **Limpieza:** dentro de `BinniTech-Respaldos` conserva los 30 `.bak` más recientes y borra temporales propios
  (`.tmp_*`). No toca ningún otro archivo de la memoria.
* **Estado:** `GET /api/usb/estado` (solo desde la PC) devuelve `activo`, `unidadConectada`, `ultimaCopia` (UTC),
  `ultimoArchivo`, `diasDesdeUltimaCopia`, `aviso` (true si nunca se copió o pasaron más de 7 días) y
  `ultimoError`. La barra lateral de la app muestra **"Última copia a USB: hace X"** y un aviso en ámbar si
  pasan más de 7 días. `POST /api/usb/copiar` copia en el momento (ignora el límite diario).
* Se guarda en `data/usb_estado.json` (no se sube a GitHub: `data/` está en `.gitignore`). Si ese archivo se
  daña, se ignora y se vuelve a crear.

**Detección de unidades**

* Windows: `os.listdrives()` (Python 3.12+) y tipo de unidad `DRIVE_REMOVABLE` (`GetDriveTypeW`). Las memorias USB
  y tarjetas SD casi siempre se reportan así. **Los discos duros externos suelen reportarse como "fijos" y no se
  detectan solos:** para ellos usa `--usb-dir E:\`.
* Linux: montajes bajo `/media` y `/run/media`. macOS: carpetas de `/Volumes`.

**Lo que no se puede hacer desde el navegador (por eso lo hace el servidor)**

* Una página web no puede saber cuándo conectan una USB ni listar las unidades. Lo único que existe es
  `showDirectoryPicker` (botón "Copiar a memoria USB (.bak)" del Bloque E): exige que una persona elija la carpeta
  **cada vez**, solo funciona en Chrome/Edge con `https://` o `localhost`, y Firefox/Safari solo pueden descargar.
* El navegador no puede copiar en segundo plano ni con la pestaña cerrada, ni distinguir una USB de otro disco.
* El servidor, a su vez, **no** puede: expulsar la memoria, cifrar la memoria USB completa, ni copiar si el servidor
  no está encendido o la USB está conectada a otra computadora (el celular no ve la USB de la PC).
* Quien tenga la memoria USB tiene el `.bak`, pero está cifrado: sin la frase de respaldo no se puede abrir. Si
  la frase se pierde, tampoco se puede recuperar (ver Bloque E).

Pruebas del Bloque L (usan carpetas temporales, nunca una USB real):

```bash
cd local-server
python -m pytest -q tests/test_usb.py
cd ../abarrotes-app && npm run test:domain      # incluye usb-backup.spec.ts
```

**Pendiente de probar:** con una memoria USB y un disco externo reales en Windows (la detección con
`GetDriveTypeW` solo se probó simulada) y con la app abierta en el navegador de la PC.

## Limitaciones conocidas

* **Falta probar en celulares reales:** la cámara en vivo con certificado autofirmado (iOS y Android),
  routers con aislamiento de clientes y la zona Wi-Fi del teléfono. Las pruebas automáticas cubren el
  protocolo, la red y el puente, no el comportamiento de cada navegador móvil.
* Si el enlace cae, los mensajes **no se encolan** (a propósito: un escaneo atrasado no debe aplicarse
  minutos después). El puente se reconecta solo.
* Un solo servidor por tienda. La PC usa SQLite como fuente de verdad en `data/inventory.sqlite3`; la persistencia principal solo está disponible desde loopback (`https://localhost:8443`).

## Estado persistente SQLite (Bloque N)

La PC debe abrir la app desde `https://localhost:8443` para usar `ServerStateStorageAdapter`. La app de Angular ejecutada con `ng serve` (puerto 4200) y las vistas abiertas desde la IP LAN no acceden a la API de estado; conservan IndexedDB en su propio navegador.

- `GET/PUT/DELETE /api/estado` administra el último snapshot por clave; `GET /api/estado/keys` lista claves y `POST /api/estado/migrar` importa desde IndexedDB solo si SQLite aún no tiene esa clave. Todos estos endpoints exigen loopback.
- `data/inventory.sqlite3` contiene `state_snapshots` (historial versionado) y `kardex_entries` (libro append-only). Las escrituras usan `BEGIN IMMEDIATE`; el servidor recalcula la cadena SHA-256 y rechaza movimientos alterados, reordenados o eliminados.
- IndexedDB funciona como espejo y contingencia ante caída temporal del servidor. Las escrituras hechas durante la caída quedan en cola local para reintento.
- Los respaldos `.bak` ahora incluyen, dentro del cifrado autenticado, el estado y una copia SQLite consistente. La restauración verifica la base y la reemplaza atómicamente.

Pruebas del Bloque N:

```bash
cd local-server
python -m pytest -q tests/test_state_store.py
```
