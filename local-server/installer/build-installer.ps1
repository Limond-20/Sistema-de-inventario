<#
.SYNOPSIS
    Compila BinniStore (Angular + PyInstaller + Inno Setup 6) en un solo paso.

.DESCRIPTION
    Genera la aplicacion autonoma y el instalador de Windows listo para distribuir:
    - Desde 'cliente-final': salida-instalador\Instalador-BinniStore-<Version>.exe (%LOCALAPPDATA%\BinniStore)
    - Desde 'main' (Demo):   salida-instalador\Instalador-BinniStore-Demo-<Version>.exe (%LOCALAPPDATA%\BinniStore-Demo)
    Al finalizar el empaquetado limpia automaticamente las carpetas temporales (build/ y dist/).

.PARAMETER Version
    Version semantica del instalador (por defecto: 1.0.0).

.PARAMETER SkipFrontend
    Omite la compilacion de Angular y reutiliza abarrotes-app\dist\abarrotes-app\browser.

.PARAMETER RebuildVendor
    Regenera las librerias offline en abarrotes-app\public\vendor usando local-server\tools.

.PARAMETER SkipInnoSetup
    Omite la creacion del instalador con Inno Setup y entrega solo la carpeta portable.

.PARAMETER KeepPortable
    Conserva local-server\build, local-server\dist y abarrotes-app\dist despues de generar el instalador.

.PARAMETER PythonExe
    Ruta explicita a python.exe (opcional; por defecto detecta local-server\.venv o PATH).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File local-server\installer\build-installer.ps1 -Version 1.0.0
#>
[CmdletBinding()]
param(
    [string]$Version = "1.0.0",
    [switch]$SkipFrontend,
    [switch]$RebuildVendor,
    [switch]$SkipInnoSetup,
    [switch]$KeepPortable,
    [string]$PythonExe = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Resolve-PythonPath {
    param([string]$ExplicitPath, [string]$LocalServerPath, [string]$RepoPath)

    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (-not (Test-Path -LiteralPath $ExplicitPath)) {
            throw "No se encontro el ejecutable de Python indicado: $ExplicitPath"
        }
        return (Resolve-Path -LiteralPath $ExplicitPath).Path
    }

    $candidates = @(
        (Join-Path $LocalServerPath ".venv\Scripts\python.exe"),
        (Join-Path $RepoPath ".venv\Scripts\python.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }

    throw "No se encontro Python. Instala Python 3.12+ o crea el entorno virtual en local-server\.venv."
}

function Resolve-IsccPath {
    $cmd = Get-Command iscc -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }

    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
        (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
    )
    foreach ($candidate in $candidates) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    return $null
}

$InstallerDir = $PSScriptRoot
$LocalServerDir = Split-Path -Parent $InstallerDir
$RepoRoot = Split-Path -Parent $LocalServerDir
$FrontendDir = Join-Path $RepoRoot "abarrotes-app"
$FrontendDistDir = Join-Path $FrontendDir "dist"
$BrowserDistDir = Join-Path $FrontendDistDir "abarrotes-app\browser"
$VendorDir = Join-Path $FrontendDir "public\vendor"
$ToolsDir = Join-Path $LocalServerDir "tools"
$SpecFile = Join-Path $InstallerDir "BinniStore.spec"
$IssFile = Join-Path $InstallerDir "BinniStore.iss"
$DistDir = Join-Path $LocalServerDir "dist"
$BuildDir = Join-Path $LocalServerDir "build"
$BundleDir = Join-Path $DistDir "BinniStore"
$BundleExe = Join-Path $BundleDir "BinniStore.exe"
$ManualPdf = Join-Path $RepoRoot "docs\manual-de-usuario.pdf"
$OutputDir = Join-Path $InstallerDir "salida-instalador"

Write-Host "BinniStore - Generador de instalador Windows (v$Version)" -ForegroundColor Green

# 0. Detectar rama Git y configurar variante aislada (Demo vs Cliente Final)
$branch = "desconocida"
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) {
    Push-Location $RepoRoot
    try {
        $detected = (& git rev-parse --abbrev-ref HEAD 2>$null)
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($detected)) {
            $branch = $detected.Trim()
        }
    }
    finally {
        Pop-Location
    }
}

if ($branch -eq "main") {
    $AppName = "BinniStore Demo"
    $AppFolderName = "BinniStore-Demo"
    $OutputPrefix = "Instalador-BinniStore-Demo"
    $AppIdGuid = "D4A18F92-3C7E-4B9A-8E2D-9F1C6A5B3E71"
    Write-Host "Modo DEMO (rama 'main'): Se generara '$OutputPrefix-$Version.exe' con datos de prueba precargados y carpeta aislada (%LOCALAPPDATA%\BinniStore-Demo)." -ForegroundColor Yellow
}
else {
    $AppName = "BinniStore"
    $AppFolderName = "BinniStore"
    $OutputPrefix = "Instalador-BinniStore"
    $AppIdGuid = "B7E49C21-6F8A-4D3E-9A1C-4E5F8B2D1A90"
    Write-Host "Modo CLIENTE FINAL (rama '$branch'): Se generara '$OutputPrefix-$Version.exe' limpio para tienda real (%LOCALAPPDATA%\BinniStore)." -ForegroundColor Cyan
}

# 1. Verificar librerias offline (vendor)
if ($RebuildVendor -or -not (Test-Path -LiteralPath $VendorDir)) {
    Write-Step "Generando librerias offline (abarrotes-app\public\vendor)"
    if (-not (Test-Path -LiteralPath (Join-Path $ToolsDir "node_modules"))) {
        throw "Faltan dependencias en local-server\tools. Ejecuta 'cd local-server\tools; npm install' primero."
    }
    Push-Location $ToolsDir
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "Fallo al generar las librerias offline en local-server\tools."
        }
    }
    finally {
        Pop-Location
    }
}

# 2. Compilar frontend Angular
if (-not $SkipFrontend) {
    Write-Step "Compilando aplicacion Angular (produccion)"
    if (-not (Test-Path -LiteralPath (Join-Path $FrontendDir "node_modules"))) {
        throw "Falta abarrotes-app\node_modules. Ejecuta 'cd abarrotes-app; npm ci' primero."
    }
    Push-Location $FrontendDir
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "Fallo la compilacion de Angular (npm run build)."
        }
    }
    finally {
        Pop-Location
    }
}
else {
    Write-Step "Omitiendo compilacion de Angular (-SkipFrontend)"
}

if (-not (Test-Path -LiteralPath (Join-Path $BrowserDistDir "index.html"))) {
    throw "No se encontro el frontend compilado en: $BrowserDistDir"
}

# 3. Resolver Python y verificar PyInstaller
Write-Step "Verificando Python y PyInstaller"
$ResolvedPython = Resolve-PythonPath -ExplicitPath $PythonExe -LocalServerPath $LocalServerDir -RepoPath $RepoRoot
Write-Host "Python detectado: $ResolvedPython" -ForegroundColor Gray

$pyiVersion = (& $ResolvedPython -m PyInstaller --version 2>&1)
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "PyInstaller no esta instalado en este entorno de Python." -ForegroundColor Yellow
    Write-Host "Configura el entorno virtual recomendado con estos comandos:" -ForegroundColor Yellow
    Write-Host "  python -m venv local-server\.venv" -ForegroundColor White
    Write-Host "  local-server\.venv\Scripts\pip install -r local-server\requirements.txt pyinstaller" -ForegroundColor White
    throw "Instala PyInstaller y vuelve a ejecutar este script."
}
Write-Host "PyInstaller detectado: $pyiVersion" -ForegroundColor Gray

# 4. Empaquetar ejecutable con PyInstaller
Write-Step "Empaquetando BinniStore.exe con PyInstaller"
& $ResolvedPython -m PyInstaller `
    --noconfirm `
    --clean `
    --distpath $DistDir `
    --workpath $BuildDir `
    $SpecFile

if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller fallo al empaquetar BinniStore.exe."
}

if (-not (Test-Path -LiteralPath $BundleExe)) {
    throw "No se genero el ejecutable esperado: $BundleExe"
}
if (-not (Test-Path -LiteralPath (Join-Path $BundleDir "_internal\browser\index.html"))) {
    throw "No se incluyo el frontend compilado dentro de _internal\browser."
}

Write-Host "Paquete portable intermedio listo en: $BundleDir" -ForegroundColor Green

# 5. Generar instalador .exe con Inno Setup 6
if ($SkipInnoSetup) {
    Write-Step "Omitiendo Inno Setup (-SkipInnoSetup)"
    Write-Host "Puedes probar la app ejecutando: $BundleExe" -ForegroundColor Green
    exit 0
}

Write-Step "Generando instalador Windows con Inno Setup 6"
if (-not (Test-Path -LiteralPath $ManualPdf)) {
    throw "No se encontro el manual de usuario requerido por el instalador: $ManualPdf"
}

$IsccExe = Resolve-IsccPath
if (-not $IsccExe) {
    Write-Warning "Inno Setup 6 (ISCC.exe) no esta instalado en este equipo."
    Write-Host "Instalalo con: winget install JRSoftware.InnoSetup" -ForegroundColor Yellow
    Write-Host "Despues vuelve a ejecutar este script (puedes usar -SkipFrontend para ir mas rapido)." -ForegroundColor Yellow
    Write-Host "Mientras tanto, la carpeta portable ya esta lista en: $BundleDir" -ForegroundColor Green
    exit 0
}

Write-Host "Inno Setup detectado: $IsccExe" -ForegroundColor Gray
& $IsccExe `
    "/DAppVersion=$Version" `
    "/DAppName=$AppName" `
    "/DAppFolderName=$AppFolderName" `
    "/DOutputPrefix=$OutputPrefix" `
    "/DAppIdGuid=$AppIdGuid" `
    $IssFile

if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup fallo al compilar el instalador."
}

$InstallerExe = Join-Path $OutputDir "$OutputPrefix-$Version.exe"
if (-not (Test-Path -LiteralPath $InstallerExe)) {
    throw "No se encontro el instalador generado en: $InstallerExe"
}

$fileInfo = Get-Item -LiteralPath $InstallerExe
$sizeMb = [Math]::Round($fileInfo.Length / 1MB, 2)
$hash = (Get-FileHash -LiteralPath $InstallerExe -Algorithm SHA256).Hash

# 6. Limpiar carpetas temporales intermedias salvo que se solicite -KeepPortable
if (-not $KeepPortable) {
    Write-Step "Limpiando compilados intermedios (build y dist)"
    foreach ($tempDir in @($BuildDir, $DistDir, $FrontendDistDir)) {
        if (Test-Path -LiteralPath $tempDir) {
            Remove-Item -LiteralPath $tempDir -Recurse -Force
        }
    }
}

Write-Host ""
Write-Host "Instalador generado con exito:" -ForegroundColor Green
Write-Host "  Archivo : $InstallerExe" -ForegroundColor White
Write-Host "  Tamano  : $sizeMb MB" -ForegroundColor White
Write-Host "  SHA-256 : $hash" -ForegroundColor White
