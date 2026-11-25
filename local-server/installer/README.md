# Instalador de Windows · BinniStore

Pipeline automatizado para generar el instalador `.exe` de Windows listo para distribuir sin exigir permisos de administrador ni instalar Python o Node.

## Dos variantes según la rama Git

El script `build-installer.ps1` detecta la rama activa y mantiene **100% separadas** las instalaciones y bases de datos de pruebas vs. cliente final (puedes tener ambas instaladas en la misma PC sin que se mezclen):

| Rama | Instalador generado | Carpeta de programa | Base de datos / Estado |
| :--- | :--- | :--- | :--- |
| **`cliente-final`** | `Instalador-BinniStore-<Version>.exe` | `%LOCALAPPDATA%\Programs\BinniStore` | `%LOCALAPPDATA%\BinniStore` (arranca limpia para tienda real) |
| **`main`** | `Instalador-BinniStore-Demo-<Version>.exe` | `%LOCALAPPDATA%\Programs\BinniStore-Demo` | `%LOCALAPPDATA%\BinniStore-Demo` (precargada con datos demo) |

Al terminar de generar el instalador `.exe`, `build-installer.ps1` **limpia automáticamente** las carpetas intermedias (`local-server/build/`, `local-server/dist/` y `abarrotes-app/dist/`) para que no queden duplicados sueltos.

## Archivos

- `BinniStore.spec`: receta de PyInstaller (empaqueta `launcher_entry.py`, `lansync`, dependencias Python y `abarrotes-app/dist/abarrotes-app/browser`).
- `BinniStore.iss`: script de Inno Setup 6 (instala en `{localappdata}\Programs\<AppFolderName>`, crea accesos directos en Escritorio y Menú Inicio, incluye `Manual-de-Usuario.pdf` y preserva `Respaldos`, `Evidencias` y `%LOCALAPPDATA%\<AppFolderName>` al actualizar o desinstalar).
- `build-installer.ps1`: script de un solo comando que ejecuta todo el flujo.

## Requisitos previos (una sola vez en la PC donde compilas)

1. **Node.js** con dependencias instaladas en el frontend:
   ```powershell
   cd abarrotes-app
   npm ci
   cd ..
   ```
2. **Entorno virtual de Python con PyInstaller**:
   ```powershell
   python -m venv local-server\.venv
   local-server\.venv\Scripts\pip install -r local-server\requirements.txt pyinstaller
   ```
3. **Inno Setup 6**:
   ```powershell
   winget install JRSoftware.InnoSetup --scope user
   ```

## Cómo generar el instalador

1. Elige la rama según lo que quieras entregar:
   - **Para una tienda real:** `git checkout cliente-final`
   - **Para pruebas / demostración con datos:** `git checkout main`
2. Ejecuta desde la raíz del repositorio:
   ```powershell
   powershell -ExecutionPolicy Bypass -File local-server\installer\build-installer.ps1 -Version 1.0.0
   ```

### Opciones útiles

- `-Version "1.2.0"`: cambia la versión mostrada en Windows y el nombre del instalador.
- `-SkipFrontend`: omite `npm run build` si ya compilaste Angular hace un momento.
- `-RebuildVendor`: vuelve a generar `abarrotes-app/public/vendor/` antes de compilar.
- `-SkipInnoSetup`: genera solo la carpeta portable en `local-server/dist/BinniStore/`.
- `-KeepPortable`: conserva las carpetas intermedias `local-server/build/`, `local-server/dist/` y `abarrotes-app/dist/` después de generar el instalador.
- `-PythonExe "C:\ruta\python.exe"`: fuerza un intérprete de Python específico.

## Notas para la PC de la tienda

- La primera vez que el tendero abre la app y conecta el celular, Windows Defender Firewall pedirá permiso para `BinniStore.exe` en **Redes privadas**; debe aceptarlo.
- Los datos reales del negocio (`inventory.sqlite3`, certificados TLS y perfil del navegador) viven en `%LOCALAPPDATA%\BinniStore` (o `%LOCALAPPDATA%\BinniStore-Demo` en la versión de pruebas), y los respaldos/evidencias en `Respaldos` y `Evidencias` junto al ejecutable. Reinstalar o actualizar no borra ninguno de esos datos.
