# Emisor de Licencias Offline (`license-issuer` · Bloque J)

Herramienta CLI en Node.js (sin dependencias externas; usa Web Crypto nativo `ECDSA P-256` con `SHA-256`) para emitir códigos cortos de licencia semestral o anual que se envían por WhatsApp a la tienda y se validan **100% sin conexión a internet**.

## 1. Generación del par de claves (la clave privada NO se versiona)

```bash
node local-server/tools/license-issuer/issue-license.mjs --keygen
```

Esto crea en `local-server/tools/license-issuer/`:
- `private-key.jwk.json` (**excluido en `.gitignore` — jamás debe subirse al repositorio**).
- `public-key.jwk.json` (clave pública `ECDSA P-256` cuyo JWK se incrusta en `abarrotes-app/src/app/domain/license.ts`).

## 2. Emisión de un código de licencia para WhatsApp

El tendero abre la pantalla **Licencia** (`/licencia`) en su punto de venta y comparte su **ID de Instalación** (ej. `BT-7K9M-4P2Q-8R5T`).

Para emitir una licencia **SEMESTRAL** (6 meses) o **ANUAL** (12 meses):

```bash
node local-server/tools/license-issuer/issue-license.mjs \
  --id BT-7K9M-4P2Q-8R5T \
  --plan SEMESTRAL
```

También se pueden especificar fechas explícitas (`--emitida YYYY-MM-DD` y `--vence YYYY-MM-DD`) o salida estructurada (`--json`):

```bash
node local-server/tools/license-issuer/issue-license.mjs \
  --id BT-7K9M-4P2Q-8R5T \
  --plan ANUAL \
  --emitida 2026-11-17 \
  --vence 2027-11-17
```

### Estructura del código emitido

```text
BT1.<base64url(JSON({idInstalación, plan, emitida, vence}))>.<base64url(firmaECDSA_P256_64bytes)>
```

- **Payload firmado (UTF-8 canónico):** `{"idInstalación":"...","plan":"SEMESTRAL"|"ANUAL","emitida":"YYYY-MM-DD","vence":"YYYY-MM-DD"}`
- **Algoritmo criptográfico:** `ECDSA` sobre curva `P-256` (`secp256r1`) con resumen `SHA-256` (Web Crypto API estándar).

## 3. Reglas operativas en la aplicación

1. **Aviso preventivo:** Desde **15 días antes de vencer** (`0 <= díasRestantes <= 15`), la aplicación muestra un aviso visible pero permite operar con normalidad.
2. **Periodo de gracia:** Una vez alcanzada la fecha de vencimiento, la tienda cuenta con **7 días de gracia** (`-7 <= díasRestantes < 0`) con aviso urgente sin bloquear las ventas.
3. **Modo solo lectura:** Tras agotarse los 7 días de gracia (`díasRestantes < -7`), la terminal entra en **modo solo lectura**: se bloquean las ventas y modificaciones de inventario, pero **siempre se permite exportar reportes en CSV y generar respaldos cifrados `.bak`** (los datos del negocio nunca se secuestran).
4. **Detección de retroceso del reloj:** La app registra la fecha/hora máxima observada (incluyendo las marcas de tiempo del Kardex encadenado SHA-256). Si el reloj de la PC se atrasa por **más de 5 minutos** respecto a la fecha máxima vista, la app entra inmediatamente en **modo solo lectura** con aviso hasta que se corrija la hora del sistema.

## 4. Alcance real y limitaciones de seguridad (Documentación honesta)

Una verificación de licencia que se ejecuta localmente en el cliente y sin internet **disuade el uso no autorizado casual, evita que se prolongue la vigencia atrasando el reloj de Windows y recuerda oportunamente la renovación del soporte**, pero **no es infalible**:

- Cualquier persona con acceso físico y privilegios de administrador sobre la PC local que tenga conocimientos técnicos podría inspeccionar el navegador, modificar los archivos JavaScript locales o sustituir la clave pública incrustada en su propia copia.
- Sin embargo, gracias a la firma asimétrica `ECDSA P-256` (cuya clave privada permanece únicamente en poder del emisor), **ningún usuario ni tienda puede fabricar códigos válidos para otras instalaciones** sin modificar el binario/código de dichas terminales.
