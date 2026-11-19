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

## 💾 Persistencia de navegador y arquitectura de datos (Bloque D)

IndexedDB se conserva como almacenamiento de contingencia y compatibilidad para los escenarios donde el servidor local no está disponible. La PC que ejecuta el servidor utiliza SQLite como fuente de verdad (Bloque N, descrito abajo).

La capa de persistencia conserva:
- En la PC, el estado operativo completo (catálogo de productos, libreta de fiado vecinal, arqueos de caja, mermas, auditorías y Kardex criptográfico append-only) se guarda primero en **SQLite** mediante `ServerStateStorageAdapter`; IndexedDB mantiene un espejo local de contingencia. Las confirmaciones de escritura de SQLite se realizan antes de completar el guardado principal. `flushSave()` se ejecuta inmediatamente tras cada operación con dinero o stock y en los eventos `pagehide` y `visibilitychange` (`hidden`), dejando el `debounce (~500 ms)` solo para cambios menores.
- Incluye **versión de esquema y migración automática** entre versiones del estado. Al arrancar, la aplicación verifica la cadena criptográfica (`verifyKardexChain`) y la continuidad por producto (`verifyProductContinuity(productos, kardex)`); el servidor vuelve a verificar SHA-256 antes de aceptar un nuevo snapshot.
- **Migración segura de versiones (v1 -> v2 -> v3) y resguardo de compatibilidad:** Al migrar el esquema a v3 (`binnitech_pos_state_v3`, que incorpora `suppliers`, `accountsPayable`, `priceHistory` y `cashMovements`), la clave previa `binnitech_pos_state_v2` (o `v1`) **NO se elimina** hasta confirmar que el estado v3 recién escrito se puede leer y supera exitosamente `validateStoredState` (validación estructural, integridad criptográfica SHA-256 de Kardex y continuidad de inventario). Si ocurre un fallo durante la escritura o validación, las claves previas permanecen intactas. **Advertencia de versión:** Si por cualquier motivo operativo se vuelve a ejecutar una versión anterior del sistema (v1 o v2), dicha versión anterior **NO podrá ver los datos creados o modificados en v3**, ya que cada versión lee exclusivamente su propia clave de almacenamiento (`v1`, `v2` o `v3`).
- **Tipo unificado `CashMovement` (Bloques F2 y H):** Los egresos por pagos a proveedores (`SALIDA`), amortizaciones de cuentas por pagar e ingresos por abonos de clientes a crédito (`ENTRADA`) registran entradas con centavos enteros (`amountCents`), fecha local `AAAA-MM-DD`, usuario, referencia y origen de fondos (`CAJA` o `FONDO_EXTERNO`). Esta estructura está diseñada para ser reutilizada directamente por el Bloque H (retiros de efectivo, gastos operativos de la tienda y arqueos de caja).
- **Resguardo ante datos dañados (sin sobrescritura automática):** Si el dato almacenado presenta daño o discrepancia de continuidad, **NO se sobrescribe**; se copia el dato crudo a `'binnitech_pos_state_corrupt_<ISO>'` (conservando las 3 copias más recientes), se bloquea el autoguardado y se presenta un modal con 3 opciones: *"Descargar datos dañados (JSON)"*, *"Empezar con datos de demostración"* (con confirmación explícita) y *"Reintentar"*.
- **Hidratación y Cola LAN:** Muestra pantalla de carga hasta completar `isHydrated`, encolando los mensajes de la LAN recibidos antes de hidratar para aplicarlos en estricto orden FIFO al terminar.
- **Exclusión mutua de escritura y guarda central `assertWritable()`:** Utiliza `navigator.locks.request('binnitech_pos_writer', { ifAvailable: true })` (con respaldo `BroadcastChannel`) para asegurar que una sola pestaña escriba; cualquier pestaña adicional entra en modo solo lectura con el aviso *"Esta app ya está abierta en otra ventana"* y todos los métodos mutadores verifican centralmente `assertWritable()`.
- **Errores de guardado visibles:** Si `flushSave()` falla ante un error del adaptador, no traga el error silenciosamente: expone `lastSaveError` y muestra el indicador `"No se pudo guardar"`. Durante una caída temporal del servidor local, IndexedDB conserva las escrituras pendientes para reintentarlas al reconectar.
- **Seguridad:** El PIN de administrador **NUNCA** se almacena en texto plano; su autenticación se realiza mediante derivación PBKDF2 (>= 600,000 iteraciones + sal criptográfica).

---

## 🗄️ SQLite como fuente de verdad de la PC (Bloque N)

Cuando la aplicación se abre en la PC desde `https://localhost:8443`, `getDefaultStorageAdapter()` selecciona `ServerStateStorageAdapter`. Este adaptador implementa la interfaz de `IndexedDbStateStorageAdapter` y utiliza la API local de `local-server`; desde otros hosts (por ejemplo, el celular que abre la IP LAN) no intenta acceder al estado privado de la PC.

- **SQLite principal:** `local-server/data/inventory.sqlite3`. La tabla `state_snapshots` conserva snapshots versionados por clave. Cada escritura inserta una nueva versión, dentro de una transacción `BEGIN IMMEDIATE`.
- **Kardex append-only:** `kardex_entries` conserva cada movimiento en orden cronológico. Antes de escribir un snapshot principal, el servidor recalcula SHA-256 y `previousHash` para toda la cadena, comprueba que los movimientos existentes sigan siendo un prefijo idéntico y agrega solo los movimientos nuevos. Triggers SQLite rechazan `UPDATE` y `DELETE` sobre el libro.
- **Contingencia IndexedDB:** después de confirmar SQLite, se actualiza una copia espejo en IndexedDB. Si el servidor no responde, se guarda localmente y queda una operación pendiente para reintentar al reconectar. Un rechazo de integridad HTTP no se convierte en un guardado local silencioso.
- **Migración inicial:** cuando una clave todavía no existe en SQLite, el adaptador busca su valor anterior en IndexedDB y llama `POST /api/estado/migrar`. El servidor solo importa si la clave sigue vacía, evitando sobrescribir una escritura concurrente.
- **Acceso restringido a la PC:** `GET/PUT/DELETE /api/estado`, `POST /api/estado/migrar` y `GET /api/estado/keys` exigen conexión loopback. Los celulares no pueden leer ni modificar esta base.
- **Respaldos completos:** los `.bak` generados por `local-server` cifran tanto el estado como una copia consistente del archivo SQLite. Al restaurar un respaldo autenticado, el servidor valida la integridad de la base y sustituye el archivo de manera atómica.

Para que SQLite sea la fuente de verdad, en la PC abre la aplicación servida por Python en `https://localhost:8443`. `ng serve` en `http://localhost:4200` usa IndexedDB porque ese origen pertenece al servidor de desarrollo de Angular, no a `local-server`.

Pruebas del bloque:

```bash
cd local-server
pip install -r requirements-dev.txt
python -m pytest -q tests/test_state_store.py
```

---

## 🔐 Respaldo Cifrado y Plan ante Fallos (Bloque E)

El sistema incluye un mecanismo de **respaldo cifrado en el servidor local (`local-server`) y exportación/importación en memoria USB** como **plan de recuperación ante fallos** (cierre accidental, limpieza del navegador, daño del perfil o cambio de equipo):

1. **Cifrado autenticado AES-256-GCM + PBKDF2-HMAC-SHA256 (600,000 iteraciones) con encabezado cubierto por AAD (`data/respaldos/AAAAMMDD-HHMMSS.bak`):**
   - `POST /api/respaldo` (accesible **únicamente desde la propia PC** por loopback) recibe el estado completo en JSON y lo cifra con **AES-256-GCM**, derivando la clave mediante **PBKDF2-HMAC-SHA256 con 600,000 iteraciones** y sal aleatoria de 16 bytes. En la PC, el archivo incluye también una copia consistente de `inventory.sqlite3`.
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

## 💽 Copia automática a USB desde el servidor local (Bloque L)

El navegador no puede detectar cuándo se conecta una memoria USB ni copiar en segundo plano (solo puede abrir
el selector de carpetas del Bloque E, y la persona debe elegir la carpeta cada vez). Por eso **`local-server`
copia solo el respaldo `.bak` más reciente a la USB, una vez al día**, y la app muestra
**"Última copia a USB: hace X"** con un aviso si pasan más de 7 días.

- Solo se copia el archivo ya cifrado (AES-256-GCM); la frase de respaldo nunca se guarda ni se copia.
- Opciones: detección automática de unidades extraíbles, `--usb-dir E:\` para una unidad o carpeta fija, o `--sin-usb`.
- Endpoints (solo desde la PC): `GET /api/usb/estado` y `POST /api/usb/copiar`.
- Detalles, límites y pruebas: ver `local-server/README.md`, sección "Copia automática a USB (Bloque L)".

---

## ⚙️ Ajustes del Negocio, Usuarios y Seguridad Criptográfica (Bloque G)

El Bloque G introduce la centralización administrativa del sistema con base en el principio de menor privilegio, trazabilidad inmutable y desvinculación de parámetros rígidos:

1. **Pantalla "Ajustes y Gestión de Usuarios" (`/ajustes`):**
   - **Barrera de acceso por PIN de Administrador:** Requiere autenticación con PIN maestro para desbloquear la vista y aplicar cambios a parámetros críticos o credenciales.
   - **Nombre comercial parametrizable:** Elimina el valor estático *"Abarrotes Doña Lupe"* de toda la aplicación, reflejando reactivamente el nombre comercial configurado en la cabecera de la app, pestaña de navegador, tickets de venta de mostrador y hoja imprimible de códigos EAN-13 y granel.
   - **Fondo inicial y umbrales financieros:** Configuración del efectivo sugerido de apertura de caja (`initialCashFloat`), umbral de margen mínimo (`marginThresholdPct`), impuestos por defecto (IVA e IEPS) y tope de descuento por ticket sin autorización de encargado/administrador (`maxDiscountPctWithoutPin`).
   - **Tiempo de bloqueo por inactividad:** Parametrización en minutos (0 a 120 min) tras los cuales la terminal bloquea automáticamente la interfaz en todos los dispositivos de mostrador.

2. **Usuarios con credenciales y matriz de permisos por rol:**
   - **Derivación criptográfica PBKDF2:** Cada usuario almacena su propio PIN derivado mediante **PBKDF2-HMAC-SHA256 con 600,000 iteraciones** y sal criptográfica de 16 bytes. El sistema incluye validación de políticas que rechaza secuencias triviales (ascendentes, descendentes o dígitos repetidos).
   - **Matriz de permisos estricta:**
     * **Cajero (`CAJERO`):** Vender en mostrador, cobrar efectivo/transferencia y abonar a libretas de crédito. Restringido de recepción, mermas, auditorías, ajustes y administración de usuarios.
     * **Encargado (`ENCARGADO`):** Todo lo de Cajero, además de recepción de compras, registro y dictamen de mermas, auditorías físicas de pasillo y cortes de turno/caja.
     * **Administrador (`ADMINISTRADOR`):** Control total, incluyendo ajustes generales, gestión de usuarios y roles, edición de precios base en catálogo, generación de respaldos cifrados y restablecimiento de datos.
   - **Atribución en Kardex:** Todo movimiento operativo se vincula de manera obligatoria al usuario autenticado actual. Se eliminó definitivamente el selector de usuario libre sin contraseña de la barra lateral.
   - **Bloqueo escalado temporal por usuario:** 3 intentos consecutivos erróneos bloquean al usuario específico por 30 segundos (primer bloqueo) o 5 minutos (bloqueos posteriores), sin afectar el acceso del resto del equipo.
   - **Pantalla de bloqueo por PIN:** Bloqueo manual desde la barra lateral o automático por inactividad, permitiendo cambiar de cajero o desbloquear mediante PIN individual.

3. **Bitácora de auditoría encadenada criptográficamente (SHA-256):**
   - Registro append-only inmutable de eventos sensibles: alta de usuarios, cambios de rol, desactivaciones/reactivaciones, cambios de PIN y modificaciones a parámetros del negocio.
   - Cada evento incluye secuencia incremental, timestamp ISO, fecha local, actor responsable, detalle y el hash SHA-256 de la entrada previa (`prevHash`), anclado en `GENESIS_SECURITY_AUDIT_HASH`.
   - La función `verifySecurityAuditChain` verifica en tiempo real la validez matemática de toda la cadena, señalando inmediatamente cualquier alteración o manipulación de datos históricos.

4. **Persistencia y migración de esquema v4 (`binnitech_pos_state_v4`):**
   - `CURRENT_SCHEMA_VERSION` incrementado a 4.
   - Migración automática de estados v3 (y retrocompatibilidad con v2 y v1) incorporando `settings`, `users` y `securityAuditLog` con valores predeterminados y usuarios demostrativos de inicio seguro.
   - La clave legacy previa (`binnitech_pos_state_v3`) se preserva intacta hasta confirmar que el estado v4 recién escrito se puede leer y supera `validateStoredState`.

---

## 🛡️ Datos personales y cifrado en reposo (Bloque K)

### 1. Cifrado en reposo de IndexedDB

- **`EncryptedStorageAdapter`** (`src/app/domain/encrypted-storage.ts`) envuelve a cualquier `StateStorageAdapter`. Hoy envuelve a `IndexedDbStateStorageAdapter`; en la PC queda así: `ServerStateStorageAdapter → EncryptedStorageAdapter → IndexedDB`, es decir, **el espejo de contingencia en IndexedDB también va cifrado**. Para cifrar otro almacenamiento basta con `new EncryptedStorageAdapter(otroAdaptador)`.
- **Algoritmo:** AES-256-GCM con IV aleatorio de 12 bytes por cada guardado. La llave de datos (aleatoria, 256 bits) se guarda **envuelta** por una llave derivada del PIN de cada administrador con **PBKDF2-HMAC-SHA256, 600,000 iteraciones y sal de 16 bytes** (una "ranura" por administrador). Cambiar un PIN solo vuelve a envolver la llave; no hay que volver a cifrar los datos.
- **Formato versionado:**
  - Registro: `{ "__btenc": 1, "alg": "AES-256-GCM", "kid", "iv", "ct" }`. El AAD es `BTENC|v1|<kid>|<clave>`, así que un registro movido a otra clave o a otro almacén no se puede descifrar.
  - Almacén de llaves `__binnitech_keystore_v1__`: `{ "format": "BTKEYS", "version": 1, "kid", "slots": [...] }`. Cada ranura guarda sus propias iteraciones (se pueden subir después sin romper nada). Versiones desconocidas se rechazan en lugar de adivinar.
- **Desbloqueo al iniciar:** si hay datos cifrados, la app muestra "Datos de la tienda cifrados" y no carga nada (ni escribe) hasta recibir el PIN de un administrador. Tras 5 intentos fallidos espera 30 s (y 5 min en los siguientes bloqueos).
- **Migración del dato sin cifrar:** la primera vez que se abre esta versión, si ya hay datos guardados en claro, se pide el **PIN actual de un administrador** (se verifica contra los usuarios guardados), se crea la llave y se cifra cada registro existente (estado, copias `corrupt_`, `prerestore_`, pendientes del servidor). Cada registro se lee de vuelta y se compara antes de darlo por migrado; si algo no cuadra, se deja el original. En una instalación nueva se pide **crear** el PIN del administrador (reemplaza al PIN de demostración).
- **Llaves por administrador:** al crear un administrador, cambiar su PIN o cuando inicia sesión sin llave (p. ej. lo acaban de promover) se le agrega/actualiza su ranura tanto en el navegador como en SQLite; al desactivarlo, borrarlo o quitarle el rol se le quita (nunca se borra la última).
- **Cifrado de SQLite en reposo (`local-server/data/inventory.sqlite3`):** `state_snapshots.payload_json` y `kardex_entries.payload_json` se cifran con AES-256-GCM en dos niveles: al arrancar por primera vez se protege con una llave aleatoria local (DPAPI en Windows / `0600` en POSIX) y, en cuanto se configura el PIN de administrador, se reemplaza por ranuras derivadas con PBKDF2-SHA256 (600,000 iteraciones). Mientras la base esté bloqueada, los endpoints de estado devuelven HTTP `423 Locked`; al restaurar un respaldo `.bak` portable, el servidor re-cifra los registros con el almacén activo manteniendo las llaves y disparadores append-only de Kardex.

### 2. ¿Y si se olvida el PIN? → Recuperación desde un respaldo

No hay puerta trasera: sin el PIN de un administrador lo cifrado en este equipo no se puede leer. La recuperación es con un **respaldo `.bak` (Bloque E) y su frase de respaldo**:

1. En la pantalla "Datos de la tienda cifrados", toca **"¿Olvidaste el PIN? Recuperar desde un respaldo (.bak)"**.
2. Elige el archivo `.bak` (disco o memoria USB) o, en la PC, uno de los respaldos del servidor local, y escribe la **frase de respaldo**. Se descifra y se valida (cadena del Kardex y continuidad) **antes** de tocar nada.
3. Elige al administrador y escribe su **PIN nuevo** dos veces.
4. Se borran los datos cifrados con el PIN olvidado, se crea una llave nueva con el PIN nuevo y se carga el respaldo. Queda registrado en la bitácora (`STORAGE_RECOVERED_FROM_BACKUP`).

⚠️ Lo que se haya movido **después** del respaldo se pierde en ese equipo. Por eso importan los respaldos automáticos y la copia a USB (Bloques E y L). Si también se perdió la frase de respaldo, los datos no se pueden recuperar.

### 3. Aviso de privacidad, consentimiento y derechos ARCO

- **Aviso configurable** (Ajustes → **Privacidad y Datos**, solo Administrador): responsable, contacto para solicitudes ARCO y texto con `{{negocio}}`, `{{responsable}}` y `{{contacto}}`. Cada publicación crea una **versión** nueva con su huella SHA-256 y se conservan todas. El texto incluido es una **plantilla**: revísenla antes de usarla con clientes reales.
- **Consentimiento por cliente de crédito:** al dar de alta un cliente hay que marcar que conoció y aceptó el aviso; se guarda **fecha y hora, versión del aviso, huella del texto, quién lo recabó** y cómo (de palabra, firma en papel u otro). Si se publica una versión nueva, el cliente aparece como "Aviso desactualizado" y se renueva desde su ficha.
- **Derechos ARCO** (Caja → Libreta de Fiado → Ficha del cliente):
  - **Acceso:** exporta un JSON con todo lo que la tienda tiene del cliente (datos, crédito, deudas, abonos, ventas, movimientos de caja, Kardex relacionado, consentimientos con el texto aceptado). Requiere PIN de encargado o administrador.
  - **Rectificación:** abre la edición del cliente y deja constancia.
  - **Cancelación:** **anonimiza** nombre, alias, teléfono y notas (también en ventas, devoluciones, movimientos de caja y alertas). Conserva el ID, el **saldo**, las deudas y los abonos. El cliente ya no puede llevar fiado nuevo, pero sí abonar. Requiere PIN de administrador y es irreversible.
  - **Oposición:** marca al cliente como "no contactar" y lo registra.
- **El Kardex no se toca:** es append-only y encadenado con SHA-256, y SQLite rechaza cualquier cambio a movimientos confirmados. Desde este bloque, los movimientos nuevos de crédito guardan **solo el ID del cliente** (`Fiado Cliente CLI-0007`) más un campo `customerId` que no entra al hash; la pantalla muestra el nombre vigente. Los movimientos **anteriores** a este bloque que traen el nombre se conservan (son contabilidad), aparecen en la exportación y se ocultan en pantalla tras una cancelación.
- La bitácora de seguridad registra consentimientos, exportaciones y anonimizaciones **solo con el ID** del cliente, nunca con su nombre.

### 4. Límites conocidos

- La fuerza del cifrado depende del PIN: uno de 6 dígitos son solo 1,000,000 de combinaciones; con la computadora robada y hardware dedicado se puede adivinar. **Usen 8 dígitos o más para los administradores.**
- La autorización por PIN en piso de venta quedó unificada en los usuarios del Bloque G (`auth.ts`), y las llaves heredadas de `localStorage` (`binnitech_pin_*`) se purgan automáticamente al iniciar.
- Después de una cancelación, el nombre puede seguir en: respaldos `.bak` anteriores (rotan a los 30), copias `corrupt_`/`prerestore_` locales (cifradas) y los snapshots históricos de `state_snapshots` en SQLite.

Pruebas del bloque: `src/app/domain/encrypted-storage.spec.ts` (K1–K10), `src/app/domain/privacy.spec.ts` (K11–K15) con `npm run test:domain`, y `src/app/services/datos-personales.service.spec.ts` (K-I1–K-I7, IndexedDB real en ChromeHeadless) con `npm test`.

---

## 📱 Sincronización de Catálogo en Vivo e Importación Masiva (Excel / CSV)

- **Catálogo en tiempo real (PC → Celular):** al conectar un teléfono por WebSocket (`abarrotes_lan_sync`), ante `CATALOG_SYNC_REQUEST` o al editar productos/nombre de tienda, la PC envía una instantánea ligera (`CATALOG_SNAPSHOT`) sin existencias ni mínimos/ROP para mantener ciego el conteo físico de auditoría, además de notificar `AUDIT_RECOUNT` cuando se solicita reconteo.
- **Importación masiva en `/catalogo`:** lector offline puro en TypeScript para archivos `.xlsx` (`DecompressionStream('deflate-raw')`) y CSV (`,` o `;`), con descarga de plantilla UTF-8 con BOM, detección de duplicados internos/existentes, control de permisos para cambios de precio (`ADMINISTRADOR`) y alta por lotes con autorización única de PIN (`CATALOG_BULK_IMPORTED`).

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
