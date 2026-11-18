# Guía de Pruebas con Usuarios y Recolección de Datos para la Convocatoria

**Versión aplicable:** Rama `cliente-final` (sistema limpio, sin datos de demostración ni simuladores)  
**Objetivo:** Validar con tenderos y dependientes reales de tiendas de abarrotes las funcionalidades principales del sistema y recabar evidencia cuantitativa y cualitativa para documentar los indicadores de impacto de la convocatoria.

---

## 1. Metas e Indicadores de la Convocatoria a Comprobar en Campo

Durante las pruebas con negocios piloto se busca medir y documentar con datos reales:

1. **Reducción de hasta 70% en la captura manual** al registrar notas de proveedores usando la cámara del celular con **OCR** y el enlace por red local (**LAN**), frente a la captura manual producto por producto.
2. **Protección de 10% a 25% de la utilidad** mediante:
   - Alertas de **margen caído** cuando un proveedor sube su costo, mostrando el **precio sugerido con redondeo comercial**.
   - Control **FEFO** (primeras caducidades en salir) y **cambio físico** con proveedores antes de que la mercancía se pierda.
3. **Control del crédito vecinal ("fiado")** separado del efectivo del cajón, con límite de deuda por cliente, fecha de vencimiento, bloqueo automático y resguardo de datos personales conforme a la **LFPDPPP** (aviso de privacidad, consentimiento y derechos **ARCO**).
4. **Detección de mermas, caducidades y robo hormiga** mediante **Kardex inmutable (SHA-256)**, captura obligatoria de fotografía en mermas, **Auditoría Ciega Exprés** en pasillo y **Corte de Turno Ciego**.
5. **Los 8 Indicadores Operativos** que consolidará el tablero en `/reportes`:
   - `Ventas` · `Márgenes` · `Mermas` · `Créditos vencidos` · `Diferencia stock-conteo` · `Tiempo por venta` · `Uso a los 30 días` · `Satisfacción del tendero`.

---

## 2. Preparación del Equipo antes de Iniciar una Prueba con un Negocio

1. Ubícate en la rama `cliente-final` y asegúrate de tener compilada la app (`abarrotes-app/dist/abarrotes-app/browser`).
2. Si vas a iniciar con una tienda nueva desde cero, verifica que `local-server/data/inventory.sqlite3` esté vacío o no exista, y limpia los datos del navegador para `https://localhost:8443/` (para que el sistema arranque en estado limpio).
3. En una terminal dentro de `local-server`, ejecuta:
   ```bash
   python -m lansync
   ```
4. En la PC de pruebas, abre `https://localhost:8443/` en Chrome o Edge (acepta el certificado autofirmado local en *Avanzado → Continuar*).
5. Ten a la mano:
   - **1 teléfono inteligente** conectado al mismo Wi-Fi que la PC (no requiere salida a internet).
   - **10 a 15 productos reales** del negocio (productos empaquetados con código EAN-13 y al menos 2 productos a granel, como frijol o queso).
   - **1 o 2 notas de remisión reales** de proveedor (o una hoja impresa con 5 artículos y al menos 1 alza de precio).
   - **Cronómetro** (para medir tiempos de captura manual vs OCR/escáner móvil y tiempo por venta).
   - **1 memoria USB** (opcional, para probar respaldo automático a USB).

---

## 3. Protocolo de 9 Pruebas Guiadas con el Usuario

> **Regla de oro para el observador:** No hagas los clics por el tendero ni por el empleado salvo que queden totalmente bloqueados. Da la indicación de la tarea, observa dónde dudan, anota el tiempo exacto y registra cualquier comentario textual.

---

### Prueba 1: Arranque en Blanco, Seguridad Inicial, Roles y Aviso de Privacidad
*Objetivo: Comprobar que el comerciante entiende la configuración inicial, el uso de PIN y la separación de permisos entre dueño y empleados.*

**Pasos con el usuario:**
1. En la pantalla inicial **"Datos de la tienda cifrados"** (`setup-new`), pedir al dueño que defina su **PIN de Administrador** (recomendado: **8 o más dígitos**) y su **frase de respaldo cifrado** (mínimo 8 caracteres; pedirle que la anote en un lugar seguro y explicarle que no es recuperable).
2. Abrir el menú lateral (`≡` en la esquina superior izquierda) → **Ajustes y usuarios** (`/ajustes`):
   - Cambiar el nombre del negocio por el nombre real de la tienda de prueba.
   - Definir fondo inicial de caja, margen mínimo (%) y tope de descuento sin PIN (%).
   - En la pestaña de **Usuarios**, crear al menos 1 **Encargado** y 1 **Cajero** con sus PIN individuales.
   - En **Privacidad y Datos**, revisar y publicar el aviso de privacidad con los datos de contacto del negocio.
3. Usar **Bloquear** en la barra superior para cambiar al usuario **Cajero**, intentar abrir desde el menú lateral `/ajustes` o `/reportes` y observar el mensaje de acceso denegado; luego volver con el **Administrador**.

**Qué medir / anotar:**
- Tiempo total de puesta en marcha inicial (meta: < 10 min).
- ¿El usuario comprendió por qué su PIN cifra la base local y que cada rol tiene permisos distintos? (`Sí / Con ayuda / No`).

---

### Prueba 2: Alta de Catálogo Real y Precios Escalonados (`/catalogo`)
*Objetivo: Verificar la facilidad para registrar mercancía con códigos múltiples, unidades de compra/venta y productos a granel.*

**Pasos con el usuario:**
1. Desde **Inicio**, entrar a **Catálogo y precios** (`/catalogo`).
2. Pedir al usuario que dé de alta **5 a 10 productos reales** de su tienda usando **+ Nuevo Producto**, incluyendo:
   - Un producto por **Pieza** con su código de barras EAN-13.
   - Un producto comprado por **Caja / Bulto** con factor de conversión (ej. caja con 24 piezas) y costo por empaque para que calcule el costo unitario.
   - Un producto a **Granel (`Kg`)** sin código de fábrica (generando **código interno** `200...`).
   - Configurar en al menos 1 producto precios escalonados de **Medio Mayoreo** y **Mayoreo**, más su **Punto de Reorden (ROP)** y fecha de caducidad.
3. Abrir la hoja imprimible de códigos internos/granel para mostrador.

**Qué medir / anotar:**
- Tiempo promedio en dar de alta un producto completo.
- Si entendió el cálculo de costo por empaque (`costo empaque / factor conversión`) y el margen sugerido.

---

### Prueba 3: Vinculación del Celular por QR y Rapidez de Cobro (`/pos`) — *Indicador: Tiempo por venta*
*Objetivo: Medir la mejora en velocidad de cobro usando el celular como escáner LAN frente a la búsqueda manual.*

**Pasos con el usuario:**
1. En la barra superior de la PC, tocar **Móvil (QR)**.
2. Con la cámara del celular, escanear el código QR. Validar la advertencia local del certificado en el navegador del celular y confirmar que aparece el indicador verde **Móvil Conectado**.
3. Abrir **Punto de venta** (`/pos`). Si el turno está cerrado, abrir turno en **Corte / Turno** con el fondo inicial.
4. **Comparativa A (Sin escáner — línea base):** Cobrar **3 ventas de muestra** (al menos 3 productos por ticket, incluyendo 1 producto a granel por monto `$` o peso `Kg`) buscando todo a mano en el buscador de la PC. **Cronometrar cada venta** desde el primer producto hasta imprimir/confirmar el cobro.
5. **Comparativa B (Con celular enlazado):** Cobrar **3 ventas equivalentes** escaneando los códigos EAN-13 con el celular enlazado y despachando granel en pantalla. **Cronometrar cada venta**.
6. Probar en mostrador:
   - Aplicar un descuento mayor al tope configurado para validar la solicitud de **PIN de autorización**.
   - Registrar 1 **Consumo Interno** (ej. producto tomado para el mostrador) eligiendo al responsable en turno.
   - Registrar 1 entrada o salida menor de efectivo en **Movimiento $** e imprimir o revisar un ticket en **Ventas / Tickets**.

**Qué medir / anotar:**
- **Tiempo promedio por venta manual (seg)** vs **tiempo promedio por venta con escáner móvil (seg)**.
- ¿El sistema ya registra el indicador `Tiempo por venta` en `/reportes`? Anotar el dato mostrado.
- Percepción de legibilidad de cambio a entregar y calculadora de granel.

---

### Prueba 4: Recepción de Mercancía con OCR vs Manual y Blindaje de Margen (`/recepcion`)
*Objetivo: Validar el ahorro de hasta 70% en captura con OCR y demostrar en vivo cómo el sistema protege el margen de ganancia ante alzas de proveedores.*

**Pasos con el usuario:**
1. Ir a **Recepción de mercancía** (`/recepcion`) y registrar primero 1 o 2 proveedores reales en la pestaña **Proveedores** (condición Contado o Crédito, días de visita, política de cambio físico).
2. **Escenario A (Captura Manual):** Entregar al tendero una nota de compra con **5 productos** (al menos 2 con aumento de costo respecto al precio anterior y 1 producto nuevo que no exista en catálogo). Pedirle que la capture en **Captura Manual** y cronometrar el tiempo hasta dejarla lista para guardar.
3. **Escenario B (OCR desde el Celular):** Desde el celular enlazado, usar la opción **Fotografiar Nota** con la misma nota (o equivalente de 5 líneas) y enviarla a la PC. Cronometrar desde que toma la foto hasta verificar las líneas en `/recepcion`. Si un producto nuevo aparece no reconocido, usar **Alta Rápida**.
4. **Blindaje de Margen Caído:** Observar que el botón de guardado permanece bloqueado mientras existan líneas en rojo (`Margen caído`). Pedir al usuario que aplique los botones **Ajustar Precio a $...** (con redondeo comercial) para recuperar el margen meta y guardar la entrada (a **Contado** o **Crédito**).
5. Si quedó una cuenta por pagar a proveedor, entrar a la pestaña de **Cuentas por Pagar** / ficha del proveedor y registrar un abono (probando origen **Cajón de la Tienda** o **Bolsillo del Dueño / Fondo Externo**).

**Qué medir / anotar:**
- **Tiempo captura manual (seg)** vs **Tiempo captura + revisión OCR (seg)** y **% de reducción de tiempo calculado**:
  $$\text{Reducción (\%)} = \frac{T_{\text{manual}} - T_{\text{OCR}}}{T_{\text{manual}}} \times 100$$
- **Margen antes del ajuste (%) vs Margen protegido después de aplicar precio sugerido (%)**.
- Errores o líneas que el OCR no reconoció y cuánto tardó en corregirlos.

---

### Prueba 5: Libreta Digital de Fiado, Bloqueos y Derechos ARCO (`/pos` → Libreta de Fiado)
*Objetivo: Validar el control de crédito vecinal y el cumplimiento práctico de protección de datos personales.*

**Pasos con el usuario:**
1. Entrar desde **Inicio → Libreta de fiados** (o en `/pos` → **Libreta de Fiado**).
2. Dar de alta **2 clientes de prueba**:
   - Cliente A con límite de crédito de `$200` y marca obligatoria de **aceptación del Aviso de Privacidad**.
   - Cliente B con límite bajo (`$50`) para probar bloqueo por tope.
3. Cargar una venta a crédito al **Cliente A** (`$120`) y luego intentar cargarle otra compra que supere su límite (`+$100`) para comprobar que el sistema **rechaza el exceso** y explica el motivo en pantalla.
4. Registrar un **Abono en Efectivo** de `$50` en la columna derecha y verificar cómo se reduce el saldo y aumenta el efectivo esperado en caja.
5. Abrir la **Ficha** del Cliente B y probar los derechos **ARCO**:
   - **Acceso:** exportar archivo JSON con PIN de encargado/admin.
   - **Rectificación / Oposición / Cancelación:** comprobar que al anonimizar al cliente por Cancelación se conservan ID, saldo, abonos y Kardex, pero ya no puede recibir fiado nuevo.

**Qué medir / anotar:**
- ¿El tendero comprendió de inmediato la diferencia entre **saldo disponible**, **deuda vencida** y **efectivo en cajón**?
- Claridad de los mensajes cuando el crédito es rechazado por límite o vencimiento.

---

### Prueba 6: Caducidades (FEFO) y Mermas con Evidencia Fotográfica (`/fefo` y `/mermas`)
*Objetivo: Verificar la prevención de pérdidas por caducidad y el candado de foto obligatoria para frenar merma simulada o robo hormiga.*

**Pasos con el usuario:**
1. Entrar a **Mermas y consumos** (`/mermas`) y navegar al módulo de **Caducidades y Cambio Físico** (`/fefo`).
2. Revisar productos con caducidad próxima y resolver al menos uno como **Cambio físico con proveedor** (actualizando la nueva fecha de caducidad) y otro enviándolo a revisión/merma.
3. Desde el **celular enlazado**, usar la función de **Registrar Merma** de un producto dañado/caducado, seleccionar motivo y **tomar la fotografía de evidencia obligatoria**.
4. En la PC (`/mermas`), revisar la foto recibida en el visor ampliado, confirmar/dictaminar la merma y observar el impacto económico registrado.

**Qué medir / anotar:**
- Facilidad para tomar y enviar la foto desde el celular sin cables ni apps externas.
- ¿La confirmación visual con foto le da mayor control frente a empleados? (`1 al 5`).

---

### Prueba 7: Auditoría Ciega Exprés de Pasillo (`/auditoria` + Celular) — *Indicador: Diferencia stock-conteo*
*Objetivo: Demostrar cómo el conteo ciego detecta faltantes reales o robo hormiga sin mostrarle al empleado cuántas piezas "deberían" haber.*

**Pasos con el usuario:**
1. Previamente, retirar a propósito 1 o 2 piezas de un producto del anaquel de prueba (simulando un faltante real).
2. Entrar a **Auditoría de pasillo** (`/auditoria`) en la PC y en el celular usar **Conteo Ciego de Pasillo** para contar físicamente 3 a 5 productos sin que el celular muestre el stock del sistema.
3. Enviar el conteo a la PC y revisar la tabla de conciliación:
   - Observar las columnas **Stock sistema vs Conteo físico**, **Diferencia en piezas** y **Diferencia en pesos ($)**.
4. Dictaminar un ajuste con PIN de Encargado/Administrador o solicitar reconteo.

**Qué medir / anotar:**
- Cantidad y monto (`$`) de la **diferencia stock-conteo** detectada en el ejercicio.
- ¿El usuario entendió el valor de que el celular oculte el stock teórico durante el conteo?

---

### Prueba 8: Corte de Turno Ciego, Encuesta de Satisfacción (1–5) y Respaldo Cifrado `.bak` / USB
*Objetivo: Validar el cierre diario sin internet, la detección de faltantes/sobrantes en caja y la seguridad ante fallas de computadora.*

**Pasos con el usuario:**
1. Desde la barra superior (**Cerrar Turno**) o en `/pos` (**Corte / Turno**), iniciar el cierre del turno.
2. Ingresar el conteo físico de billetes y monedas (primero probar con `$10` menos de lo esperado para verificar la alerta de diferencia, luego corregir o registrar motivo en notas).
3. Responder la **encuesta semanal de satisfacción del tendero (1 a 5)** dentro del cierre (anotando por qué eligió esa calificación).
4. Ingresar el PIN de supervisor y la **frase de respaldo** para ejecutar el cierre junto con el respaldo automático cifrado (`AES-256-GCM`).
5. Abrir el menú lateral (`≡`) → **Respaldar ahora** para consultar el último respaldo, o verificar en `local-server/data/respaldos/` que se generó el archivo `.bak` cifrado (y si hay USB conectada, verificar en la misma ventana el estado de copia a USB).
6. Revisar `/licencia` para mostrarle al usuario la vigencia de licencia local e integridad del reloj.

**Qué medir / anotar:**
- Calificación de satisfacción registrada en la encuesta (`1` a `5`).
- Tiempo para completar el corte de caja vs el método tradicional de cuaderno.
- Verificación de generación exitosa del archivo `.bak` cifrado y copia a USB.

---

### Prueba 9: Consolidación y Exportación de los 8 Indicadores Operativos (`/reportes`)
*Objetivo: Extraer el paquete numérico verificable por tienda para el expediente de la convocatoria.*

**Pasos con el investigador / evaluador:**
1. Ir al menú lateral (`≡`) → **Reportes e indicadores** (`/reportes`).
2. Seleccionar el periodo **Hoy** (o **Rango** que abarque los días de piloto de esa tienda).
3. Revisar en el tablero las **8 tarjetas de indicadores**:
   1. **Ventas**
   2. **Márgenes**
   3. **Mermas**
   4. **Créditos vencidos**
   5. **Diferencia stock-conteo**
   6. **Tiempo por venta**
   7. **Uso a los 30 días** (seguimiento posterior a 30 días de operación real)
   8. **Satisfacción del tendero**
4. Hacer clic en **CSV 8 Indicadores** y en **Exportar ... (CSV)** / **Imprimir reporte** para conservar la evidencia documental del negocio evaluado.

---

## 4. Plantilla de Recolección de Evidencia por Tienda (Copiar por cada Negocio Evaluado)

### A. Ficha del Negocio Piloto
- **Folio / Nombre de la tienda:** `____________________________________`
- **Municipio / Localidad (Istmo u otra región):** `____________________________________`
- **Fecha de prueba:** `____ / ____ / 202__`
- **Evaluador(es):** `____________________________________`
- **Equipo usado (PC + modelo de celular):** `____________________________________`
- **Personal participante y roles:** `____________________________________`
- **¿Cómo llevaba su inventario y crédito antes del piloto?** `[ ] Libreta  [ ] Memoria  [ ] Excel  [ ] Otro POS`

### B. Matriz de Resultados Cuantitativos (Evidencia para Convocatoria)

| Métrica evaluada | Método actual (antes) | Con el sistema (después) | Mejora / Diferencia observada |
|---|---:|---:|---:|
| Tiempo de registro nota de 5 productos (Manual vs OCR) | `____ seg` | `____ seg` | `____ % menos tiempo` |
| Tiempo promedio por venta en mostrador (Manual vs QR Móvil) | `____ seg` | `____ seg` | `____ seg menos / venta` |
| Alza detectada en nota de proveedor (margen antes vs ajustado) | `____ %` | `____ %` | `+____ pts de margen protegidos` |
| Diferencia stock sistema vs conteo físico en auditoría ciega | No medido | `____ pzas ($____)` | Hallazgo documentado |
| Diferencia en corte de turno (efectivo contado vs esperado) | No medido | `$____` | Cuadre verificado |
| Tiempo para realizar corte de caja diario | `____ min` | `____ min` | `____ % menos tiempo` |
| Respaldo cifrado `.bak` generado y probado | `[ ] N/A` | `[ ] Sí  [ ] No` | USB copiada: `[ ] Sí  [ ] No` |
| Encuesta de satisfacción del tendero (1 a 5) | — | `___ / 5` | Comentario clave abajo |

### C. Resumen de los 8 Indicadores Exportados desde `/reportes`
- **1. Ventas del periodo:** `$________________` (`____ tickets`)
- **2. Margen bruto promedio:** `________ %`
- **3. Mermas registradas:** `$________________` (`____ registros`)
- **4. Créditos vencidos / cartera total:** `$________________` / `$________________`
- **5. Diferencia stock-conteo:** `$________________` (`____ artículos auditados`)
- **6. Tiempo por venta reportado por el sistema:** `________ seg`
- **7. Seguimiento de uso a los 30 días *(llenar en visita/llamada día 30)*:** `[ ] Activo diario  [ ] Activo parcial  [ ] Abandonó` — Razón: `________________`
- **8. Satisfacción del tendero (día 1 y día 30):** Día 1: `___ / 5` · Día 30: `___ / 5`

### D. Hallazgos de Usabilidad (Para Mejora Continua)
1. **Pasos donde el usuario dudó o pidió ayuda:**
   - `________________________________________________________________`
2. **Funciones más valoradas por el tendero / empleado:**
   - `________________________________________________________________`
3. **Problemas técnicos de red local / cámara / iluminación observados:**
   - `________________________________________________________________`
4. **Cita textual del tendero (con autorización para documentar el piloto):**
   > *"________________________________________________________________"*
