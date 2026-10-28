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
- El estado operativo completo (catálogo de productos, libreta de fiado vecinal, arqueos de caja, mermas, auditorías y Kardex criptográfico append-only) se resguarda en **IndexedDB** del navegador de la PC local con guardado diferido (`debounce ~500 ms`) para evitar saturación de I/O.
- Incluye **versión de esquema y migración automática**.
- Si el dato almacenado estuviera dañado o la cadena del Kardex fuese alterada, el sistema arranca con los datos de demostración limpios y despliega una alerta visible.
- Cuenta con un botón **"Restablecer datos de demostración"** con diálogo de confirmación para reiniciar pruebas en cualquier momento.
- **Seguridad:** El PIN de administrador **NUNCA** se almacena en texto plano; su autenticación se realiza mediante derivación PBKDF2 (>= 600,000 iteraciones + sal criptográfica).

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
