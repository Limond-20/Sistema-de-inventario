# Sistema Híbrido de Gestión de Inventario para Tiendas de Abarrotes 🏪🇲🇽

Prototipo interactivo de alta usabilidad diseñado específicamente para usuarios con baja alfabetización digital (tenderos y dependientes de abarrotes en México), enfocado en pruebas simultáneas en **PC (escritorio)** y **Celular**.

---

## 🚀 Características Principales

### 🖥️ Entregable 1: Aplicación de Escritorio (Angular 20 + Tailwind CSS)
* **Zero atajos ocultos:** Toda la navegación y acciones se realizan mediante botones táctiles/visuales grandes (mínimo 56px), bordes reforzados y textos explícitos.
* **Colores Semánticos Estrictos:**
  - 🟢 **Verde (`#16a34a`):** Entradas de mercancía, confirmaciones y márgenes saludables.
  - 🟠 **Ámbar (`#d97706`):** Alertas de "Cambio Físico" con repartidores (caducidades próximas) y auditorías.
  - 🔴 **Rojo (`#dc2626`):** Alertas de margen caído por aumento de costo de proveedor y mermas.
* **Datos 100% Realistas:** Sin "Lorem Ipsum". Incluye productos de marcas mexicanas líderes (Leche Lala 1L, Aceite Nutrioli 850ml, Frijol Negro Granel 50kg, Huevo Bachoco 18 pzas, Atún Dolores 140g, etc.).
* **Vistas Integradas:**
  - `Navbar`: Título claro y botón **"📱 Vincular Celular (Código QR)"** con código QR simulado en SVG e instrucciones en 2 pasos sencillos.
  - `Dashboard`: Alertas matutinas priorizadas y 4 accesos principales gigantes.
  - `Recepción`: Carga de nota por OCR o captura manual con blindaje de márgenes (bloqueo de guardado hasta resolver precios en rojo).
  - `Auditoría Ciega`: Conciliación de existencias en el sistema vs conteo físico en anaquel con diferencias en pesos ($) y acciones de ajuste o reconteo.
  - `Catálogo y Precios`: Búsqueda, filtrado por categorías y cálculo de días restantes para cambio físico.
  - `Mermas`: Registro y supervisión de pérdidas semanales con evidencias fotográficas.

### 📱 Entregable 2: Prototipo Móvil (`public/movil-prototipo.html`)
Archivo independiente (monolítico en HTML + Tailwind CDN + Vanilla JS) ejecutable directamente en el navegador de cualquier smartphone:
1. **Menú Principal:** Indicador de estado de conexión (`🟢 Conectado a la PC de la Tienda`) y accesos táctiles gigantes.
2. **Fotografiar Nota (OCR):** Carga de foto de nota de remisión o uso de nota simulada con animación de escaneo.
3. **Conteo Ciego de Pasillo:** Muestra el producto sin revelar el stock del sistema, teclado numérico táctil en pantalla y resumen editable.
4. **Registro de Merma:** Escaneo de producto dañado, selección guiada de motivo, captura obligatoria de foto y cálculo automático de la pérdida económica.

---

## 🛠️ Tecnologías
- **Angular 20** (Standalone Components & Signals)
- **Tailwind CSS v4**
- **HTML5 / Vanilla JavaScript** (para el cliente móvil autónomo)

---

## 💾 Persistencia y Arquitectura de Datos (Bloque D)

> **Nota para el equipo:** esto es una solución de prototipo; la base definitiva será SQLite en local-server, con la PC como fuente de verdad.

En esta fase de prototipo:
- El estado operativo completo (catálogo de productos, libreta de fiado vecinal, arqueos de caja, mermas, auditorías y Kardex criptográfico append-only) se resguarda en **IndexedDB** del navegador de la PC local (`tx.oncomplete` / `tx.onerror` / `tx.onabort`), ejecutando `flushSave()` inmediato tras cada operación con dinero o stock y en los eventos `pagehide` y `visibilitychange` (`hidden`), dejando el `debounce (~500 ms)` solo para cambios menores.
- Incluye **versión de esquema y migración automática**, así como verificación en el arranque de la cadena criptográfica (`verifyKardexChain`) y continuidad por producto (`verifyProductContinuity(productos, kardex)`).
- **Migración segura de versiones (v1 a v2) y resguardo de compatibilidad:** Al migrar el esquema a v2 (`binnitech_pos_state_v2`), la clave previa `binnitech_pos_state_v1` **NO se elimina** hasta confirmar que el estado v2 recién escrito se puede leer y supera exitosamente `validateStoredState` (validación de estructura, Kardex encadenado y continuidad). Si ocurre un fallo de escritura o lectura en v2, la clave v1 permanece intacta. **Advertencia de versión:** Si por cualquier motivo operativo se vuelve a ejecutar una versión anterior del sistema (v1), dicha versión anterior **NO podrá ver los datos creados o modificados en v2**, ya que las versiones v1 leen exclusivamente `binnitech_pos_state_v1`.
- **Resguardo ante datos dañados (sin sobrescritura automática):** Si el dato almacenado presenta daño o discrepancia de continuidad, **NO se sobrescribe**; se copia el dato crudo a `'binnitech_pos_state_corrupt_<ISO>'` (conservando las 3 copias más recientes), se bloquea el autoguardado y se presenta un modal con 3 opciones: *"Descargar datos dañados (JSON)"*, *"Empezar con datos de demostración"* (con confirmación explícita) y *"Reintentar"*.
- **Hidratación y Cola LAN:** Muestra pantalla de carga hasta completar `isHydrated`, encolando los mensajes de la LAN recibidos antes de hidratar para aplicarlos en estricto orden FIFO al terminar.
- **Exclusión mutua de escritura y guarda central `assertWritable()`:** Utiliza `navigator.locks.request('binnitech_pos_writer', { ifAvailable: true })` (con respaldo `BroadcastChannel`) para asegurar que una sola pestaña escriba; cualquier pestaña adicional entra en modo solo lectura con el aviso *"Esta app ya está abierta en otra ventana"* y todos los métodos mutadores verifican centralmente `assertWritable()`.
- **Errores de guardado visibles:** Si `flushSave()` falla ante un error del adaptador, no traga el error silenciosamente: expone `lastSaveError` y muestra el indicador `"No se pudo guardar"`.
- **Seguridad:** El PIN de administrador **NUNCA** se almacena en texto plano; su autenticación se realiza mediante derivación PBKDF2 (>= 600,000 iteraciones + sal criptográfica).

---

## 🔐 Respaldo Cifrado y Plan ante Fallos (Bloque E)

El sistema incluye un mecanismo de **respaldo cifrado en el servidor local (`local-server`) y exportación/importación en memoria USB** como **plan de recuperación ante fallos** (cierre accidental, limpieza del navegador, daño del perfil o cambio de equipo):

1. **Cifrado autenticado AES-256-GCM + PBKDF2-HMAC-SHA256 (600,000 iteraciones) con encabezado cubierto por AAD (`data/respaldos/AAAAMMDD-HHMMSS.bak`):**
   - `POST /api/respaldo` (accesible **únicamente desde la propia PC** por loopback) recibe el estado completo en JSON y lo cifra con **AES-256-GCM** (`cryptography` en Python y Web Crypto API en TypeScript), derivando la clave mediante **PBKDF2-HMAC-SHA256 con 600,000 iteraciones** y sal aleatoria de 16 bytes.
   - El encabezado binario de 28 bytes (`BTBAK` + `version=1` + `kdf_id=1` + `cipher_id=1` + `uint32 BE iterations` + `16B salt`) viaja autenticado como **AAD (Additional Authenticated Data)** de AES-GCM, permitiendo incrementar los parámetros en el futuro y garantizando compatibilidad cruzada entre `local-server` y `backup.ts`.
   - Conserva automáticamente los **30 respaldos más recientes** en `local-server/data/respaldos/`.
   - `GET /api/respaldo` lista los respaldos disponibles (`nombre`, `fecha`, `tamaño`), `GET /api/respaldo/{nombre}` valida estrictamente el patrón `^[0-9]{8}-[0-9]{6}\.bak$` (bloqueando cualquier intento de *path traversal* como `../` o `%2e%2e%2f`), y `POST /api/respaldo/restaurar` descifra y devuelve el JSON original; ante una frase incorrecta o cualquier byte manipulado en el cuerpo o encabezado AAD responde **`403 No autorizado`** sin detalles.
2. **Restauración segura, copia previa y "Deshacer restauración":**
   - Antes de aplicar cualquier respaldo (desde el servidor o importado desde un archivo `.bak` en disco/USB), el servicio valida la cadena criptográfica del Kardex y la continuidad de existencias con `validateStoredState`, resguarda el estado actual en `'binnitech_pos_state_prerestore_<ISO>'` y habilita la opción **"Deshacer restauración"**.
3. **Advertencia crítica — La frase perdida NO se puede recuperar:**
   - La frase de respaldo (mínimo 8 caracteres) se solicita la primera vez en la sesión y **NUNCA se guarda en disco, `localStorage` ni `IndexedDB`**.
   - Mientras no haya frase en memoria se muestra el aviso permanente `"Respaldo automático detenido: ingresa la frase"`, un banner de alerta si el último respaldo tiene más de 24 horas, y el cierre de turno solicita la frase antes de cerrar.
   - **Si se pierde u olvida la frase de respaldo, es criptográficamente imposible recuperar o descifrar los archivos `.bak`.** Se recomienda anotarla y resguardarla físicamente en la caja fuerte del negocio.
4. **Respaldo manual, automático e indicadores de guardado:**
   - Incluye botón **"Respaldar ahora"**, respaldo automático **al cerrar turno de caja** y **cada hora si hubo cambios**, además de indicadores visibles en tiempo real (`"Guardado"`, `"Guardando…"`, `"No se pudo guardar"`) tanto para `IndexedDB` como para `Respaldo`, y la leyenda `"Último respaldo: hace X"`.
5. **Copia e importación en memoria USB y limitación en navegadores sin soporte:**
   - La opción **"Copiar a memoria USB (.bak)"** utiliza la **File System Access API** (`window.showDirectoryPicker`) para escribir el archivo `.bak` directamente en la carpeta de la memoria USB elegida por el tendero, y la sección **"Importar respaldo .bak desde disco o memoria USB"** permite restaurarlo en otra PC.
   - **Limitación de navegador:** `showDirectoryPicker` solo está soportado en navegadores basados en Chromium (Google Chrome, Microsoft Edge) bajo contexto seguro (`https://` o `localhost`). En navegadores sin soporte (como Firefox o Safari), el sistema realiza automáticamente la **descarga directa del archivo `.bak`** para que el usuario pueda guardarlo o moverlo a la memoria USB desde su carpeta de descargas.

---

## 🏃 Cómo Ejecutar el Proyecto

### 1. Iniciar la Aplicación de Escritorio (PC):
```bash
cd abarrotes-app
npm install
npm start
```
Abre en tu navegador: [http://localhost:4200](http://localhost:4200)

### 2. Abrir el Prototipo Móvil (Celular):
- En la PC, abre: [http://localhost:4200/movil-prototipo.html](http://localhost:4200/movil-prototipo.html) (o abre directamente el archivo en tu navegador móvil dentro de la misma red local).


---

## 🧪 Pruebas Automatizadas

* **Pruebas de dominio Angular (TypeScript puro):**
  `ash
  cd abarrotes-app && npm run test:domain
  `
  *(Requiere **Node.js >= 22.6** para ejecución nativa con --experimental-strip-types)*

* **Pruebas de servidor y frescura CSS (Python pytest):**
  `ash
  cd local-server && python -m pytest -q
  `

* **Pruebas de integración del puente WebSocket:**
  `ash
  cd local-server && NODE_TLS_REJECT_UNAUTHORIZED=0 node --test tests/bridge.test.mjs
  `
