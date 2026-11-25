# Instalador de Windows · BinniStore

Pipeline automatizado para generar:
1. **Aplicación autónoma (`BinniStore.exe`)** usando PyInstaller (`--onedir --noconsole`) sobre `local-server/launcher_entry.py`, con el frontend Angular compilado y el servidor HTTPS/WebSocket incluidos.
2. **Instalador de Windows (`Instalador-BinniStore-<version>.exe`)** usando Inno Setup 6, listo para entregar a una tienda sin exigir permisos de administrador ni instalar Python/Node.

## Archivos

- `BinniStore.spec`: receta de PyInstaller (empaqueta `launcher_entry.py`, `lansync`, dependencias Python y `abarrotes-app/dist/abarrotes-app/browser`).
- `BinniStore.iss`: script de Inno Setup 6 (instala en `%LOCALAPPDATA%\Programs\BinniStore`, crea accesos directos en Escritorio y Menú Inicio, incluye `Manual-de-Usuario.pdf` y preserva `Respaldos`, `Evidencias` y `%LOCALAPPDATA%\BinniStore` al actualizar o desinstalar).
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
3. **Inno Setup 6** (para producir el instalador `.exe` final):
   ```powershell
   winget install JRSoftware.InnoSetup
   ```

## Cómo generar el instalador

> **Importante:** Para entregar a una tienda real, compila desde la rama `cliente-final` (sin datos de demostración):
> ```powershell
> git checkout cliente-final
> ```

Ejecuta desde la raíz del repositorio:

```powershell
powershell -ExecutionPolicy Bypass -File local-server\installer\build-installer.ps1 -Version 1.0.0
```

### Opciones útiles

- `-Version "1.2.0"`: cambia la versión mostrada en Windows y el nombre del instalador.
- `-SkipFrontend`: omite `npm run build` si ya compilaste Angular hace un momento.
- `-RebuildVendor`: vuelve a generar `abarrotes-app/public/vendor/` antes de compilar.
- `-SkipInnoSetup`: genera solo la carpeta portable en `local-server/dist/BinniStore/`.
- `-PythonExe "C:\ruta\python.exe"`: fuerza un intérprete de Python específico.

## Salidas generadas (ignoradas por Git)

- **Carpeta portable:** `local-server/dist/BinniStore/BinniStore.exe`
- **Instalador final:** `local-server/installer/salida-instalador/Instalador-BinniStore-<Version>.exe`

## Notas para la PC de la tienda

- La primera vez que el tendero abre la app y conecta el celular, Windows Defender Firewall pedirá permiso para `BinniStore.exe` en **Redes privadas**; debe aceptarlo.
- Los datos reales del negocio (`inventory.sqlite3`, certificados TLS y perfil del navegador) viven en `%LOCALAPPDATA%\BinniStore`, y los respaldos/evidencias en `%LOCALAPPDATA%\Programs\BinniStore\Respaldos` y `Evidencias`. Reinstalar o actualizar el instalador no borra ninguno de esos datos.
- Si más adelante cambias el nombre o ícono oficial de la marca, actualiza:
  - `abarrotes-app/public/favicon.ico` (ícono multi-tamaño `.ico`), `icon.svg` y `apple-touch-icon.png`,
  - `AppName`, `AppPublisher` y `OutputBaseFilename` en `BinniStore.iss`,
  - `name` en `BinniStore.spec` y `markers` / título del diálogo en `local-server/launcher_entry.py`.
