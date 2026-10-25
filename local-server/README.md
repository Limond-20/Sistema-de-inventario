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

Luego, en la PC, abre `https://localhost:8443/vincular`: aparece un **código QR**. En el celular
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
  reescanear el QR cada mañana. El botón *Generar código nuevo* de `/vincular` lo invalida y
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
* La ventana de "Vincular celular" de la PC sigue siendo simulada: puede abrir `/vincular` o mostrar
  el mismo QR con `GET /api/pairing` (solo responde desde la PC).

## Limitaciones conocidas

* **Falta probar en celulares reales:** la cámara en vivo con certificado autofirmado (iOS y Android),
  routers con aislamiento de clientes y la zona Wi-Fi del teléfono. Las pruebas automáticas cubren el
  protocolo, la red y el puente, no el comportamiento de cada navegador móvil.
* Si el enlace cae, los mensajes **no se encolan** (a propósito: un escaneo atrasado no debe aplicarse
  minutos después). El puente se reconecta solo.
* Un solo servidor por tienda. Los datos siguen viviendo en la memoria de la app (sin persistencia).
