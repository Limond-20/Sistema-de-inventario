# Manual de Usuario · Sistema de Inventario y Punto de Venta

Guía práctica para dueños, encargados y cajeros de tienda de abarrotes.  
Este manual explica cómo usar cada pantalla y herramienta del sistema tanto en la **computadora de caja** como en el **celular enlazado**, con lenguaje claro y paso a paso.

---

## Índice

1. [Introducción y Roles de Usuario](#1-introducción-y-roles-de-usuario)
2. [Encendido del Sistema y Configuración Inicial](#2-encendido-del-sistema-y-configuración-inicial)
3. [Pantalla de Inicio y Barra Superior](#3-pantalla-de-inicio-y-barra-superior)
4. [Vincular el Celular con Móvil (QR) y Terminal Móvil](#4-vincular-el-celular-con-móvil-qr-y-terminal-móvil)
5. [Catálogo y Precios](#5-catálogo-y-precios)
6. [Punto de Venta, Caja y Libreta de Fiados](#6-punto-de-venta-caja-y-libreta-de-fiados)
7. [Recepción de Mercancía, Proveedores y Cuentas por Pagar](#7-recepción-de-mercancía-proveedores-y-cuentas-por-pagar)
8. [Caducidades y Cambio Físico con Proveedor](#8-caducidades-y-cambio-físico-con-proveedor)
9. [Mermas y Bajas de Mercancía](#9-mermas-y-bajas-de-mercancía)
10. [Auditoría de Pasillo (Conteo Ciego)](#10-auditoría-de-pasillo-conteo-ciego)
11. [Reportes e Indicadores del Negocio](#11-reportes-e-indicadores-del-negocio)
12. [Respaldos Cifrados (.bak) y Copia Automática a USB](#12-respaldos-cifrados-bak-y-copia-automática-a-usb)
13. [Ajustes, Usuarios, Privacidad y Bitácora](#13-ajustes-usuarios-privacidad-y-bitácora)
14. [Licencia y Vigencia del Sistema](#14-licencia-y-vigencia-del-sistema)
15. [Preguntas Frecuentes y Solución de Problemas](#15-preguntas-frecuentes-y-solución-de-problemas)

---

## 1. Introducción y Roles de Usuario

El sistema funciona **100% de manera local dentro de tu tienda**, sin depender de internet para vender, escanear productos con el celular, leer notas de proveedor o guardar respaldos.

Toda la información de ventas, inventario, fiados y precios queda protegida bajo llave con tu **PIN de Administrador**, y cada movimiento importante queda anotado en un historial que no se puede borrar ni alterar.

### ¿Qué puede hacer cada rol en la tienda?

Para cuidar el dinero de la caja y la mercancía del negocio, el sistema maneja tres roles de acceso:

| Operación / Módulo | Cajero | Encargado | Administrador |
| :--- | :---: | :---: | :---: |
| Vender en Punto de Venta (POS) | Permitido | Permitido | Permitido |
| Cobrar efectivo / transferencia | Permitido | Permitido | Permitido |
| Abonar a cuenta de fiado | Permitido | Permitido | Permitido |
| Consultar Catálogo e imprimir hoja de códigos | Permitido | Permitido | Permitido |
| Alta/aprobación de productos y baja en Catálogo | Restringido | Permitido | Permitido |
| Modificar precios en Catálogo | Restringido | Restringido | Permitido |
| Recepción de mercancía y facturas | Restringido | Permitido | Permitido |
| Revisión de mermas y bajas | Restringido | Permitido | Permitido |
| Auditoría física de pasillo | Restringido | Permitido | Permitido |
| Cortes de turno y arqueos | Restringido | Permitido | Permitido |
| Reportes e indicadores del negocio | Restringido | Permitido | Permitido |
| Ajustes del negocio y parámetros | Restringido | Restringido | Permitido |
| Gestión de usuarios, permisos y cambio de PIN | Restringido | Restringido | Permitido |
| Respaldos cifrados (`.bak`) y restauración | Restringido | Restringido | Permitido |

---

## 2. Encendido del Sistema y Configuración Inicial

### 2.1 Cómo encender el servidor de la tienda

1. En la computadora principal de la tienda, abre la carpeta `local-server` y haz doble clic en:
   - **`iniciar-servidor.bat`** (en Windows), o
   - **`iniciar-servidor.sh`** (en Linux/Mac), o ejecuta `python -m lansync` en una terminal.
2. Verás una ventana negra con el mensaje **`Servidor de la tienda en marcha`** y la dirección **`https://localhost:8443/`**. **No cierres esta ventana mientras uses la tienda** (si la cierras, el servidor se detiene).
3. En la misma PC, abre Google Chrome o Microsoft Edge y entra a **`https://localhost:8443/`**.
   - **La primera vez** aparecerá un aviso de seguridad del navegador. Toca **Avanzado** y luego **Continuar a localhost**. Esto es normal porque el certificado de seguridad lo generó tu propia computadora para que funcione sin internet.

> **Importante:** Para funciones sensibles como vincular celulares por QR, ver fotos de merma o guardar respaldos, abre siempre la aplicación desde `https://localhost:8443/` en la computadora principal.

### 2.2 Primer día: crear el PIN de Administrador

La primera vez que abres el sistema aparece la pantalla **"Crea el PIN del administrador"**:

1. Escribe un **PIN numérico** de al menos 6 dígitos (**se recomienda 8 o más dígitos**) que no sea fácil de adivinar (evita secuencias como `123456` o números repetidos como `111111`).
2. Repite el PIN y presiona **Crear PIN y cifrar**.
3. Anota este PIN en un lugar seguro donde solo el dueño tenga acceso.

### 2.3 Inicio diario y cambio rápido de usuario

- **Al abrir la tienda cada día:** aparecerá la pantalla **"Datos de la tienda cifrados"**. Escribe el PIN de un Administrador y toca **Abrir datos**.
- **Cambiar de empleado en mostrador:** toca el botón **Bloquear** en la esquina superior derecha. Aparecerá la ventana **Terminal Bloqueada** para elegir el **Usuario** de la lista, escribir su **PIN de Acceso** (con opción de **Mostrar PIN** si necesitas verificar lo que tecleas) y tocar **Desbloquear**.
- **Si un usuario falla su PIN 3 veces seguidas**, queda bloqueado temporalmente por seguridad.

### 2.4 ¿Olvidaste el PIN de Administrador?

Si se olvida el PIN principal no existe una contraseña maestra oculta; la recuperación se hace con un archivo de respaldo:

1. En la pantalla de desbloqueo inicial, toca **`¿Olvidaste el PIN? Recuperar desde un respaldo (.bak)`**.
2. Elige el archivo `.bak` desde tu memoria USB o disco duro (o selecciona uno guardado en el servidor local).
3. Escribe la **Frase de respaldo** con la que se protegió ese archivo y presiona **Verificar respaldo**.
4. Elige al administrador, define un **PIN nuevo**, repítelo y confirma. Los datos regresarán exactamente al momento en que se tomó ese respaldo.

---

## 3. Pantalla de Inicio y Barra Superior

### 3.1 Barra superior y menú lateral

En la parte superior siempre verás:
- **Botón Menú (`≡`):** abre el menú lateral con acceso a **Inicio**, **Reportes e indicadores**, **Ajustes y usuarios**, **Licencia** y el botón **Respaldar ahora**. También muestra avisos si falta respaldo o estado de la memoria USB.
- **Botón `Móvil (QR)`:** muestra el código QR para enlazar celulares (cuando ya hay uno conectado cambia a verde y dice **Móvil Conectado**).
- **Botón `Cerrar Turno`:** visible para Encargado y Administrador; abre el corte de caja rápido desde cualquier sección.
- **Panel de usuario:** muestra tu nombre, tu rol (`ADMINISTRADOR`, `ENCARGADO` o `CAJERO`) y el botón **Bloquear**.

### 3.2 Tablero principal (`/`)

En el centro de la pantalla están las **6 tarjetas de operación diaria**:

1. **Punto de venta:** cobro en mostrador, granel, ventas en efectivo y fiado.
2. **Recepción de mercancía:** ingreso de notas de compra (foto por celular o manual), proveedores y pagos pendientes. Muestra avisos en rojo si hay productos con margen de ganancia caído.
3. **Auditoría de pasillo:** revisión de conteos ciegos hechos con el celular.
4. **Libreta de fiados:** acceso directo a las cuentas de crédito de vecinos, saldos vencidos y abonos.
5. **Catálogo y precios:** alta, edición, códigos de barras, existencias y precios por volumen.
6. **Mermas y consumos:** revisión de bajas con foto y acceso directo a caducidades próximas (`Por caducar`).

Debajo verás el **Resumen de Caja** en vivo (**Cajón**, **Crédito Colocado**, **Consumo Interno**, **Fondo Inicial**) y, si corresponde cambio de mes, el botón **Revisar clasificación mensual de productos** para aprobar o posponer la clasificación A, B y C.

Encima de las tarjetas pueden aparecer **alertas automáticas**:
- **Alertas de stock negativo o faltantes en sistema:** te permite capturar el conteo físico real y cuadrarlo con PIN usando **Ajustar (PIN)**.
- **Pagos a Proveedores Próximos a Vencer:** te avisa facturas a crédito por vencer con enlace directo para pagarlas.
- **Alzas de Costo de Proveedor Detectadas:** te avisa cuando subió el costo de compra de un producto.

### 3.3 Botones de ayuda `?`

En campos que pueden generar dudas verás un pequeño círculo **`?`**:
- Pasa el cursor encima o tócalo en pantalla táctil para abrir una ventana breve que explica **qué significa el campo y para qué sirve** (por ejemplo, *Avisar para surtir*, *Reserva mínima*, *Merma normal por pesaje*, *IEPS*, *Clave corta del producto* y *Derechos ARCO*).

---

## 4. Vincular el Celular con Móvil (QR) y Terminal Móvil

El celular de la tienda o del encargado sirve como **escáner láser inalámbrico**, **cámara para leer notas de proveedor** y **herramienta de conteo en pasillo**, sin instalar ninguna aplicación de tienda de aplicaciones.

### 4.1 Paso a paso para vincular el celular

1. Conecta el celular al **mismo Wi-Fi** que la computadora (no importa si ese Wi-Fi no tiene internet).
2. En la PC, haz clic en **`Móvil (QR)`** en la barra superior.
3. Si la PC tiene más de una red activa (por ejemplo cable e inalámbrica), usa el selector **`¿Qué red usa tu celular?`** para elegir la dirección IP correcta de tu Wi-Fi.
4. Abre la cámara de tu celular y apunta al **código QR**. Toca el enlace que aparece en pantalla.
5. **La primera vez**, el navegador del celular mostrará una advertencia de seguridad: toca **Avanzado** y luego **Continuar** (es seguro, porque la conexión va directo a tu PC local).
6. En el modal de la PC cambiará de *Esperando celular…* a verde: **`1 celular enlazado en vivo`**. La vinculación dura 30 días sin tener que escanear cada mañana.

### 4.2 ¿Cómo desvincular celulares?

Si un empleado deja de usar su teléfono o cambiaste de equipo:
1. Abre **`Móvil (QR)`** en la barra superior de la PC.
2. Toca **`Generar código nuevo`** y presiona **Confirmar**. Todos los celulares anteriores perderán acceso de inmediato.

### 4.3 Las 4 herramientas de la Terminal Móvil

Al entrar en el celular verás el icono superior de sonido/vibración (para activar o silenciar el pitido al escanear) y 4 tarjetas:

1. **Lector de Mostrador (POS):**
   - Toca **Iniciar Cámara** para escanear códigos de barras en vivo, o **Subir Foto** para leer el código desde una fotografía.
   - Cada lectura suena, vibra y manda el producto directo al ticket abierto en la PC.
   - Si escaneas un producto que todavía no existe en tu catálogo, aparece la tarjeta **Código no registrado en catálogo** con el botón **Crear producto** (pide nombre, precio, costo y unidad). Ese producto se envía a la PC como *pendiente de aprobación* hasta que un Encargado o Administrador lo apruebe con su PIN en Catálogo.
2. **Recepción y Notas (OCR):**
   - Toca **Tomar Foto a la Nota / Factura Física**, enfoca bien la nota de compra y espera a que reconozca el texto en español.
   - Revisa los renglones detectados y toca **Mandar a Recepción de PC** para auditar costos y guardar la entrada.
3. **Auditoría Ciega de Pasillo:**
   - Muestra producto por producto (ubicación, nombre, clave y unidad) **sin mostrar cuántas piezas dice la computadora** para que el conteo físico sea real y sin sesgos.
   - Escribe la cantidad contada usando el teclado numérico gigante en pantalla y toca **Guardar y Siguiente** (o **Omitir** si no pudiste contarlo en ese momento).
   - Al terminar, revisa la lista y toca **Enviar Conteo a la Computadora**.
4. **Reporte de Mermas:**
   - Selecciona el motivo (**Empaque Roto**, **Caducado** o **Daño Manejo**).
   - Elige el **Producto Dañado** y ajusta las **Unidades a Dar de Baja** (`−` / `+`).
   - Toca **Tomar Foto** (la evidencia fotográfica es obligatoria).
   - Presiona **Reportar Merma a la Computadora** para enviarla a revisión.

---

## 5. Catálogo y Precios

Disponible en la tarjeta **Catálogo y precios** (`/catalogo`). Todos los usuarios pueden consultarlo, pero solo **Encargado** y **Administrador** pueden crear, aprobar o desactivar productos, y solo el **Administrador** puede cambiar precios de venta en catálogo.

### 5.1 Alta de un producto nuevo

Toca **`Alta de Producto`** para abrir la ventana **Alta de Nuevo Producto**:

1. **Identificación y ubicación:**
   - **Nombre del Producto \*:** nombre claro con presentación (ej. *Leche Lala Entera 1L*).
   - **Clave corta del producto:** se genera automáticamente al escribir nombre y categoría; si quieres otra, edítala o usa **Autogenerar**. (Ver ayuda `?`).
   - **Categoría, Ubicación Física en Tienda y Proveedor:** al empezar a escribir te sugiere opciones ya usadas en tu tienda para evitar duplicados por escritura.
2. **Unidades de Venta, Compra y Costos:**
   - **Unidad de Venta:** `Pieza`, `Kg`, `g`, `L`, `ml`, etc.
   - **Unidad de Compra y Unidades por empaque:** si compras por caja o bulto y vendes por pieza, indica cuántas piezas trae la caja (ej. `24`).
   - **Costo por Empaque ($):** al escribir lo que te cuesta la caja completa, el sistema calcula solo el **Costo Unitario Venta ($)**.
   - **Precio Menudeo ($) \***, **IVA (%)**, **IEPS (%)** (botón `?` explica cuándo dejar en `0%`) y **Merma normal por pesaje (%)** (para granel).
3. **Precios Escalonados por Volumen:**
   - Configura opcionalmente **Cant. Mín. Medio Mayoreo / Precio Medio Mayoreo ($)** y **Cant. Mín. Mayoreo / Precio Mayoreo ($)**. En caja se aplicarán automáticamente cuando el cliente lleve esa cantidad o más.
4. **Códigos de Barras del Producto:**
   - Escanea o escribe uno o varios códigos de fábrica y toca **Agregar Código** (útil si distintas presentaciones o lotes traen códigos distintos). El sistema bloquea códigos duplicados en otros productos.
   - Si el producto es suelto o no tiene código de fábrica, toca **Crear código propio de la tienda** (o simplemente guarda sin código: el sistema generará un código interno automáticamente para imprimir).
5. **Caducidad, Alertas y Existencia Inicial:**
   - **Fecha de Caducidad:** fecha próxima del lote actual.
   - **Reserva mínima:** respaldo de seguridad en anaquel (botón `?`).
   - **Avisar para surtir:** cantidad mínima a partir de la cual el sistema te avisará en amarillo que toca pedir mercancía al proveedor (botón `?`).
   - **Venta a granel / báscula:** marca esta casilla para productos que se pesan o venden por monto en `$`.
   - **Existencia actual en tienda** y **PIN de encargado o administrador \*:** si ingresas piezas iniciales mayores a `0`, escribe el PIN para autorizar el registro de arranque en el historial.
6. Toca **Guardar Nuevo Producto**.

### 5.2 Buscar, filtrar y administrar el catálogo

- **Filtros por importancia en ganancias (A, B y C):**
  - **Clase A:** productos más vendidos que dejan el mayor porcentaje de ganancia.
  - **Clase B:** venta regular y complementarios.
  - **Clase C:** venta lenta.
- **Buscador:** escribe nombre, clave corta, ubicación o código de barras. Marca **Mostrar productos desactivados** si necesitas recuperar un producto dado de baja.
- **Acciones por producto:**
  - **Editar:** actualiza datos, precios o códigos.
  - **+ Cód. Propio:** asigna un código interno imprimible si todavía no tiene uno.
  - **Desactivar / Eliminar:** si el producto nunca ha tenido ventas ni entradas, se puede **Eliminar**; si ya tiene historial, se guarda como **Desactivado** (requiere PIN) para no alterar tus reportes pasados. Luego puedes usar **Reactivar**.

### 5.3 Productos creados desde el celular

Cuando un empleado da de alta un código desconocido desde el celular en mostrador, aparece en la parte superior de Catálogo en amarillo (**Productos Nuevos desde Móvil**):
- Nadie puede cobrar ese producto en caja hasta que un **Encargado o Administrador** toque **Aprobar (PIN)**, revise costo/precio e ingrese su PIN (o toque **Rechazar**).

### 5.4 Hoja imprimible de códigos propios y granel

Toca **`Imprimir Códigos para Granel y Mostrador`** en la barra superior de Catálogo para abrir una hoja lista con los nombres, precios y códigos de barras de todos los artículos propios o a granel. Toca **Imprimir / Guardar en PDF** para tenerla pegada junto a la caja y escanear sin buscar a mano.

---

## 6. Punto de Venta, Caja y Libreta de Fiados

Disponible en la tarjeta **Punto de venta** (`/pos`).

### 6.1 Abrir y cerrar el turno de caja

- Si ves el aviso amarillo **"Turno de caja cerrado"**, la venta está bloqueada para proteger tus cuentas.
- Toca **Abrir Nuevo Turno** (o **Corte / Turno** en la barra superior del POS), escribe el **Fondo Inicial de Caja ($)** (la morralla que hay en el cajón) y autoriza con PIN de Encargado o Administrador.

### 6.2 Cobrar una venta en mostrador

1. **Agregar productos al ticket:**
   - Escanea con tu **lector USB** en el buscador superior, o con la cámara del **celular vinculado**, o busca por nombre y presiona **Enter** o **+ Agregar**, o toca un botón de **Acceso Rápido**.
2. **Despacho a granel (báscula):**
   - Al elegir un producto marcado como granel se abre la ventana **Despacho de Granel** con dos pestañas:
     - **Por Monto en Dinero ($):** botones rápidos (`$15`, `$20`, `$25`, `$30`, `$50`, `$100`) o monto exacto. Te muestra exactamente cuántos gramos y kilos despachar en báscula.
     - **Por Peso en Báscula (Kg):** botones de `250 g`, `500 g`, `1.000 kg`, `1.500 kg` o lectura manual de báscula. Calcula el total en pesos al instante.
3. **Ajustar cantidades, niveles y descuentos en el Ticket Actual:**
   - Usa **`−`**, **`+`**, escribe la cantidad directa o toca **Quitar**.
   - Si el producto tiene **Medio Mayoreo** o **Mayoreo** configurados, el nivel cambia según la cantidad o puedes elegirlo manualmente en **Nivel**.
   - Puedes aplicar descuento por línea (**Desc. Línea (%)**) o global (**Desc. Ticket (%)**). Si el descuento rebasa el **Tope sin PIN** configurado, al cobrar te pedirá el **PIN de Autorización** de Administrador/Encargado.
4. **Cobrar Efectivo:**
   - Toca el botón verde **Cobrar Efectivo ($...)**.
   - Elige el billete entregado (`$20`, `$50`, `$100`, `$200`, `$500`, `$1000`, **Exacto** u **Otro monto recibido**).
   - Verás en grande el **Cambio a Entregar** y toca **Confirmar y Cobrar**.
   - Aparecerá el botón **Imprimir Ticket (#folio)** para enviar a impresora térmica (formato 58 mm o 80 mm) o guardar copia.

### 6.3 Libreta de Fiados (Crédito a Clientes)

Puedes entrar desde **Libreta de fiados** en Inicio, desde el botón **Libreta de Fiado** arriba en POS, o al cobrar tocando **Cargar a Crédito**:

- **Dar de alta a un cliente (`+ Nuevo Cliente`):**
  - Captura nombre, alias, teléfono, límite de crédito y días de plazo.
  - Selecciona si aceptó el **Aviso de Privacidad** (de palabra en mostrador, firma en papel u otro medio) y guarda.
- **Cargar una compra a crédito:**
  - Selecciona al cliente en la lista y verifica el recuadro de dictamen (el sistema bloquea automáticamente nuevas compras si el cliente tiene **saldo vencido** o **rebasa su límite de crédito**).
  - Toca **Autorizar y Cargar**. Las compras fiadas **no suman efectivo al cajón** hasta que el cliente venga a abonar.
- **Registrar Abono a Cuenta:**
  - En la columna derecha de la Libreta, elige al **Cliente que abona**, selecciona la **Forma de pago** (`Efectivo` entra al cajón; `Transferencia / SPEI` o `Tarjeta` no alteran efectivo físico), ingresa el monto y presiona **Registrar Abono**.
- **Ficha del cliente y Derechos ARCO (Privacidad):**
  - Toca **Ficha** en cualquier cliente para ver su crédito disponible, historial de compras fiadas, historial de abonos y el panel **Privacidad y derechos ARCO** (con botón **`?`** explicativo):
    - **Acceso:** exportar sus datos en archivo JSON.
    - **Rectificación:** corregir su nombre, alias, teléfono o notas.
    - **Oposición:** marcar que el cliente pidió no recibir avisos o recordatorios.
    - **Cancelación (anonimizar):** borra para siempre sus datos personales conservando solo el folio contable y saldo histórico (requiere **PIN de Administrador**).

### 6.4 Consumo Interno

Cuando el dueño o un empleado toma mercancía para alimentos o uso de la propia tienda:
1. Agrega los artículos al Ticket Actual y toca **Consumo Interno**.
2. Selecciona quién es el **Responsable**.
3. Si el consumo deja un saldo negativo en sistema, ingresa PIN de Administrador y el motivo.
4. Toca **Confirmar Consumo**. Se descuenta del inventario al **costo** (sin sumar dinero a la venta ni al cajón).

### 6.5 Entradas y salidas de efectivo (`Movimiento $`)

Sirve para registrar dinero que entra o sale del cajón sin ser una venta (ej. agregar cambio, retirar efectivo por seguridad o pagar garrafones/servicios menores):
1. Toca **`Movimiento $`** en la barra superior del POS.
2. Elige **`(+) Entrada`** o **`(-) Salida / Retiro`**.
3. Escoge el **Motivo / Concepto**, escribe el **Monto en pesos ($)** y una nota opcional, y presiona **Registrar Movimiento**.

### 6.6 Historial de tickets, reimpresión y devoluciones (`Ventas / Tickets`)

1. Toca **`Ventas / Tickets`** arriba en POS.
2. Filtra por **Todos**, **Efectivo** o **Fiado**, o busca por folio, cliente o cajero.
3. En cada venta puedes:
   - **Ticket:** ver el comprobante e imprimirlo en formato 58 mm o 80 mm (las copias muestran la marca de reimpresión).
   - **Devolver:** abre la ventana **Devolver Mercancía** para regresar artículos parciales o **Devolver Todo (Cancelar Venta)**:
     - Elige el destino físico de la mercancía devuelta: **Stock vendible** (regresa al inventario) o **Merma directa** (si venía dañada o caducada).
     - En ventas fiadas cuyo reembolso supera la deuda pendiente, elige entre **Saldo a Favor** o **Reembolso en Efectivo**.
     - Escribe el motivo obligatorio, ingresa PIN de Encargado/Administrador y confirma.

### 6.7 Corte de Caja y Cierre de Turno

Al finalizar el turno o al cerrar la tienda:
1. Toca **`Corte / Turno`** (en POS) o **`Cerrar Turno`** (en la barra superior de la app).
2. Revisa el resumen: *Fondo Inicial + Ventas en Efectivo + Abonos en Efectivo + Entradas - Salidas = Efectivo Teórico Esperado*.
3. Cuenta físicamente los billetes y monedas del cajón y escribe la cifra en **Efectivo Físico Contado en Cajón ($)**.
4. El sistema indicará en **Estado del Arqueo** si la caja está **Cuadrada**, con **Sobrante** o con **Faltante**.
5. Si aparece la **Encuesta semanal de satisfacción** (sale una vez por semana), puedes calificar del 1 al 5 cómo sentiste el sistema.
6. Ingresa el **PIN Encargado / Admin \* ** (y la frase de respaldo si aún no la capturas en esta sesión) para cerrar el turno y generar automáticamente el respaldo cifrado.

---

## 7. Recepción de Mercancía, Proveedores y Cuentas por Pagar

Disponible en la tarjeta **Recepción de mercancía** (`/recepcion`). Solo pueden operar aquí **Encargado** y **Administrador**.

Tiene **3 pestañas** en la parte superior:

### 7.1 Pestaña `Recepción de Mercancía`

Puedes ingresar notas de dos formas:
- **Nota Recibida por OCR (Celular / Foto):** muestra automáticamente la nota fotografiada desde el celular con proveedor, folio y renglones detectados.
- **Captura Manual de Factura / Nota:** elige el **Producto**, ajusta la **Cantidad** (en su unidad de compra, como caja o bulto), captura el **Costo** y toca **+ Agregar**.
- Si viene un artículo que nunca habías registrado en tu catálogo, toca **`+ Alta Rápida de Producto`** arriba a la derecha para darlo de alta al vuelo sin perder la nota.

#### Alerta de Margen Caído (Protección de Ganancia)

Cada renglón compara el **Costo Anterior** contra el **Costo Nuevo**:
- Si el proveedor subió el precio y tu ganancia cayó por debajo de tu margen meta, el renglón se pinta de rojo con **Margen caído: X%** y **el botón de guardar se bloquea** para que no vendas perdiendo dinero sin darte cuenta.
- Toca el botón **`Ajustar Precio a $...`** en cada renglón rojo. El sistema calcula un precio nuevo redondeado comercialmente que protege tu ganancia y lo marca en verde (**Precio protegido**).

#### Guardado de la compra (Contado o Crédito)

En la barra inferior selecciona:
1. **Proveedor**
2. **Pago:** **Contado** (si ya se liquidó) o **Crédito** (indica el **Plazo en días**, ej. 7 o 15 días, para crear la cuenta por pagar).
3. Toca **`Guardar Entrada en Inventario`**. Se actualizarán existencias, costos, fechas de caducidad y precios ajustados en un solo paso.

### 7.2 Pestaña `Directorio de Proveedores`

- Consulta tus proveedores registrados, da de alta nuevos (`Nuevo Proveedor`), edita días de visita/reparto, condiciones de pago (`Contado` / `Crédito`), plazo y si aceptan **cambio físico** de productos próximos a caducar.
- Toca **Ficha e Historial** en un proveedor para consultar los cambios de costo que te ha hecho por producto a lo largo del tiempo.

### 7.3 Pestaña `Cuentas por Pagar (CxP)`

- Muestra todas las notas a crédito pendientes o vencidas y su saldo.
- Toca **`Pagar Esta Nota`** (o **`Registrar Pago a Proveedor`**) para abonar o liquidar:
  - Elige el **Origen de los fondos**:
    - **Cajón de la Tienda:** descuenta el dinero del efectivo en caja (si excede lo disponible, pedirá PIN de encargado).
    - **Bolsillo del Dueño (Fondo Externo):** registra el pago al proveedor sin tocar el efectivo del cajón ni descuadrar tu corte de caja.
  - Selecciona **Método de pago** (`Efectivo` o `Transferencia bancaria / Cheque`), escribe el monto y confirma.

---

## 8. Caducidades y Cambio Físico con Proveedor

Disponible desde el menú lateral o desde **Mermas y consumos → `Caducidades y Cambios con Proveedor`** (`/fefo`).

1. **Agenda de Ruta — Proveedores en Ruta (Próximas 48 Horas):**
   - Muestra qué repartidores visitan la tienda hoy o **Llega Mañana**, su teléfono y si tienen convenio de **Mano a Mano (Sin costo)**.
2. **Lotes que deben separarse del estante hoy:**
   - Lista los lotes con etiqueta **Vence en 48h** y la cantidad exacta **A Separar** para que los metas a la canasta de devoluciones antes de que pase el repartidor.
3. **Al atender al repartidor tienes dos acciones:**
   - **`Registrar Cambio Exitoso`:** selecciona la **Nueva caducidad** del lote fresco que te dejaron y toca el botón para renovar el lote sin pérdida.
   - **`Rechazado / Mandar a Merma`:** si el proveedor no aceptó el cambio físico o venció sin convenio, envía ese lote directo al registro de mermas para descontarlo correctamente.

---

## 9. Mermas y Bajas de Mercancía

Disponible en la tarjeta **Mermas y consumos** (`/mermas`).

- Arriba verás **3 indicadores**: *Pérdida Neta Semanal* (valuada al costo), *Envase Roto en Piso* y *Caducado sin Devolución*.
- Cada reporte enviado desde el celular (o generado desde caducidades rechazadas) muestra su **miniatura de fotografía**: haz clic en la foto para abrir el **visor en grande** y verificar el daño real.
- Para descontar definitivamente la mercancía del sistema, el Encargado o Administrador debe presionar **`Confirmar Revisión`**:
  - Si la merma reportada excede la existencia registrada en el sistema, se abrirá la ventana **Autorizar Baja de Merma con PIN** pidiendo PIN de Administrador y el motivo justificado.

---

## 10. Auditoría de Pasillo (Conteo Ciego)

Disponible en la tarjeta **Auditoría de pasillo** (`/auditoria`). Sirve para encontrar robo hormiga, productos mal cobrados o errores de captura sin que quien cuenta "acomode" los números.

1. Un encargado o empleado toma el celular enlazado, abre **Auditoría Ciega de Pasillo**, cuenta físicamente en el anaquel (sin ver lo que marca la computadora) y presiona **Enviar Conteo a la Computadora**.
2. En la PC se muestran los resultados comparando **En Sistema** contra **En Estante**, más la diferencia en unidades y en dinero (**Cuadran Exacto**, **Faltante en Dinero** y **Sobrante en Dinero**).
   - Para productos a granel, el sistema indica si la diferencia cae dentro de la **Merma natural** permitida configurada en el catálogo.
3. En cada producto con diferencia puedes elegir una de tres acciones:
   - **`Autorizar Merma Natural`** / **`Merma Normal Granel/Corte`:** ajusta el stock al conteo físico como merma operativa.
   - **`Faltante Injustificado`:** ajusta el stock al conteo físico dejando registro del faltante.
   - **`Pedir Reconteo`:** manda de regreso el producto al celular para confirmar contando una segunda vez antes de ajustar.
   - Si te equivocaste en un dictamen antes de cerrar, usa **Deshacer**.

---

## 11. Reportes e Indicadores del Negocio

Disponible en el menú lateral (`≡`) → **Reportes e indicadores** (`/reportes`). Solo accesible para **Encargado** y **Administrador**.

1. **Elige el periodo a consultar:** botones **Hoy**, **Semana**, **Mes** o **Rango** (para elegir fecha inicial *Desde* y final *Hasta*).
2. **Tablero de los 8 Indicadores Operativos:**
   1. **Ventas:** ingresos brutos, devoluciones y ventas netas.
   2. **Márgenes:** margen promedio real de tus productos vendidos.
   3. **Mermas:** costo total de mercancía perdida.
   4. **Créditos vencidos:** saldo vencido en la libreta de fiado.
   5. **Diferencia stock-conteo:** faltantes o sobrantes detectados en auditorías.
   6. **Tiempo por venta:** rapidez promedio de atención en mostrador.
   7. **Uso a los 30 días:** constancia de operación registrada en el último mes.
   8. **Satisfacción del tendero:** promedio de las encuestas semanales (`Calificar` si hay una pendiente).
3. **Reportes detallados (7 pestañas):** haz clic sobre cualquier indicador o pestaña (**Ventas**, **Márgenes**, **Mermas**, **Créditos vencidos**, **Stock vs. conteo**, **Tiempo por venta**, **Valor inventario**) para ver el detalle por producto, hora o cliente.
4. **Exportar o Imprimir:**
   - **`CSV 8 Indicadores`:** descarga una hoja compatible con Excel con el resumen de los 8 indicadores.
   - **`Exportar [Pestaña] (CSV)`:** descarga el detalle completo del reporte actual para Excel.
   - **`Imprimir reporte`:** abre la vista de impresión o permite guardarlo como **PDF**.

---

## 12. Respaldos Cifrados (.bak) y Copia Automática a USB

Toda la base de datos de tu tienda puede resguardarse en archivos `.bak` cifrados con contraseña para que, si se descompone la computadora, nunca pierdas tu catálogo, fiados ni historial.

### 12.1 La Frase de Respaldo

- La primera vez que hagas un respaldo o cierres caja en el día te pedirá escribir una **Frase de respaldo** (mínimo 8 caracteres).
- **Muy importante:** por seguridad, **esa frase nunca se guarda en el disco duro**. Anótala en una libreta segura: **si la olvidas, nadie podrá abrir ni descifrar tus archivos `.bak`**.

### 12.2 Cómo respaldar manualmente y cuándo se hace solo

- **Automático:** cada vez que realizas un cierre de caja y también cada hora mientras usas el sistema (si hubo cambios).
- **Manual:** abre el menú lateral (`≡`) → **`Respaldar ahora`** (disponible para Encargado y Administrador) y confirma la frase para guardar hasta los últimos **30 respaldos más recientes** en el servidor local.

### 12.3 Copia automática a memoria USB

Mientras la computadora tenga conectada una memoria USB:
- El servidor local detecta la memoria automáticamente y guarda el respaldo más reciente del día dentro de la carpeta **`BinniTech-Respaldos`** (verificando que quede completo e íntegro).
- Desde el modal **Respaldo Cifrado del Servidor Local** (al tocar el estado de respaldo o desde el aviso en el menú) también puedes presionar **`Copiar a memoria USB (.bak)`** en cualquier momento.

### 12.4 Cómo restaurar o pasar la tienda a otra computadora

En el mismo modal **Respaldo Cifrado del Servidor Local**:
- **Desde la lista del servidor:** elige la fecha que deseas recuperar, toca **Restaurar** e ingresa tu frase de respaldo. (Si acabas de restaurar por error, verás el botón **Deshacer restauración**).
- **Desde archivo `.bak` en memoria USB u otra PC:** en la sección **Importar respaldo .bak desde disco o memoria USB (otra PC)**, selecciona el archivo `.bak`, escribe su frase y presiona **`Importar y restaurar .bak`**.

---

## 13. Ajustes, Usuarios, Privacidad y Bitácora

Disponible en el menú lateral (`≡`) → **Ajustes y usuarios** (`/ajustes`). Requiere autorización con **PIN de Administrador**.

Cuenta con **5 pestañas**:

1. **Parámetros del Negocio:**
   - Configura **Nombre Comercial de la Tienda**, **Fondo Inicial de Caja**, **Umbral de Margen Mínimo (%)**, **IVA por Defecto (%)**, **IEPS por Defecto (%)**, **Tiempo de Bloqueo por Inactividad (Minutos)** (`0` para desactivar) y **Tope Máximo de Descuento sin Autorización PIN (%)**. Presiona **Guardar Parámetros**.
2. **Usuarios y Permisos:**
   - Crea empleados con **`+ Alta de Usuario`** (nombre, rol `Cajero`, `Encargado` o `Administrador`, y PIN numérico de 6+ dígitos).
   - Cambia el rol de un empleado o usa **Desactivar** / **Reactivar** cuando sea necesario.
   - Consulta la **Matriz Documentada de Permisos y Roles** para ver qué puede hacer cada puesto.
3. **Seguridad y PIN:**
   - Selecciona tu propio usuario o el de cualquier empleado para cambiarle o restablecerle el PIN (si eres Administrador y cambias el de alguien más, escribes tu propio PIN de Administrador para autorizar).
   - *Nota:* cuando un Administrador cambia su PIN, también se actualiza su llave de apertura de la tienda automáticamente.
4. **Privacidad y Datos:**
   - Revisa la tarjeta de **Datos protegidos bajo llave en este equipo** y la lista de **Clientes de crédito sin consentimiento vigente**.
   - Edita el **Aviso de privacidad para clientes de crédito** (Responsable, Contacto para solicitudes ARCO y texto de la plantilla) y toca **Publicar nueva versión**.
5. **Bitácora de Auditoría:**
   - Muestra si el **Historial de Seguridad está Íntegro y sin Alteraciones** y la tabla cronológica con cada acción crítica registrada (cambios de PIN, altas de usuarios, ajustes de precios, anulaciones, respaldos) con usuario y sello de verificación.

---

## 14. Licencia y Vigencia del Sistema

Disponible en el menú lateral (`≡`) → **Licencia** (`/licencia`).

- Muestra el **Estado de Licencia** (Activa, Por vencer, **Periodo de gracia de 7 días** o Vencida), el plan contratado, fecha de vencimiento y días restantes.
- **Si la licencia vence después del periodo de gracia:** el sistema entra en **Modo solo lectura** (se bloquea el cobro en caja, pero **siempre podrás exportar tus Reportes en CSV y descargar o copiar tus respaldos `.bak`** para que tu información jamás quede atrapada).
- **Cómo renovar sin internet:**
  1. Copia tu **ID Único de Instalación** con el botón **Copiar ID para enviar por WhatsApp**.
  2. Recibe tu código corto de activación (inicia con `BT1...`).
  3. Pégalo en el recuadro **Ingresar o Renovar Código de Licencia** y presiona **`Validar y Activar Licencia`**.
- **Integridad del Reloj:** verifica que la fecha de la computadora no haya sido atrasada manualmente para proteger el historial y la vigencia.

---

## 15. Preguntas Frecuentes y Solución de Problemas

### El celular no abre el código QR o no se enlaza con la PC
- Verifica que la computadora y el celular estén en **la misma red Wi-Fi**. (Si el Wi-Fi de la calle o un módem público bloquea la comunicación entre aparatos, activa la **Zona Wi-Fi / Compartir internet** del celular y conecta la PC a ella; no consume tus datos móviles al usar la tienda).
- En la PC, abre **`Móvil (QR)`** y prueba cambiar de red en el selector **`¿Qué red usa tu celular?`** si aparecen varias opciones.
- Si es la primera vez en ese celular y sale advertencia de seguridad, toca **Avanzado → Continuar**.
- Revisa que la ventana negra del servidor (`python -m lansync`) siga abierta y que en Windows hayas permitido el acceso de Python en redes **Privadas**.

### La caja no me deja cobrar ("Turno de caja cerrado")
- Un Encargado o Administrador debe abrir el turno desde **Corte / Turno → Abrir Nuevo Turno**, ingresar el fondo inicial de efectivo y confirmar con su PIN.

### No me deja guardar una entrada de mercancía en Recepción
- Revisa si hay renglones en rojo marcados con **`Margen caído`**. El proveedor subió su precio de venta; toca **`Ajustar Precio a $...`** en los renglones en rojo (o actualiza tu margen) para desbloquear el botón **`Guardar Entrada en Inventario`**.

### No puedo vender un producto recién escaneado con el celular
- Por seguridad, los productos nuevos registrados rápidamente desde el celular quedan pendientes. Un Encargado o Administrador debe entrar a **Catálogo y precios** (`/catalogo`) y presionar **Aprobar (PIN)** en la sección superior amarilla.

### Aparece el aviso "Esta app ya está abierta en otra ventana · Modo solo lectura"
- Para evitar cobros duplicados o daños al inventario, solo puedes operar en **una pestaña del navegador a la vez** en la PC. Cierra la otra pestaña repetida y recarga tu ventana principal.

### ¿Qué pasa si se va la luz en la tienda?
- Cada venta, abono y recepción se guarda en el momento en la base local de la computadora (`SQLite`). Al regresar la luz, abre de nuevo `iniciar-servidor.bat` (o `python -m lansync`), entra a `https://localhost:8443/` y desbloquea con tu PIN. Además, conserva siempre una memoria USB conectada para tener copia diaria en `BinniTech-Respaldos`.
