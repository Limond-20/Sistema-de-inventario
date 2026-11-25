# -*- mode: python ; coding: utf-8 -*-
"""Especificación PyInstaller para generar el ejecutable autónomo BinniStore.exe.

Uso recomendado:
    powershell -ExecutionPolicy Bypass -File local-server/installer/build-installer.ps1
"""

import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules

INSTALLER_DIR = Path(SPECPATH).resolve()
LOCAL_SERVER_DIR = INSTALLER_DIR.parent
REPO_ROOT = LOCAL_SERVER_DIR.parent

if str(LOCAL_SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(LOCAL_SERVER_DIR))

ENTRY_SCRIPT = LOCAL_SERVER_DIR / "launcher_entry.py"
BROWSER_DIST = REPO_ROOT / "abarrotes-app" / "dist" / "abarrotes-app" / "browser"
ICON_FILE = REPO_ROOT / "abarrotes-app" / "public" / "favicon.ico"

if not (BROWSER_DIST / "index.html").is_file():
    raise FileNotFoundError(
        f"No se encontró el frontend compilado en: {BROWSER_DIST}\n"
        "Compila Angular primero ejecutando 'npm run build' dentro de abarrotes-app/."
    )

hidden_imports = sorted(
    set(
        collect_submodules("lansync")
        + [
            "anyio._backends._asyncio",
            "cryptography",
            "fastapi",
            "h11",
            "segno",
            "sqlite3",
            "starlette",
            "uvicorn",
            "uvicorn.lifespan",
            "uvicorn.lifespan.off",
            "uvicorn.lifespan.on",
            "uvicorn.logging",
            "uvicorn.loops",
            "uvicorn.loops.asyncio",
            "uvicorn.loops.auto",
            "uvicorn.protocols",
            "uvicorn.protocols.http",
            "uvicorn.protocols.http.auto",
            "uvicorn.protocols.http.h11_impl",
            "uvicorn.protocols.websockets",
            "uvicorn.protocols.websockets.auto",
            "uvicorn.protocols.websockets.websockets_impl",
            "websockets",
            "websockets.legacy",
            "websockets.legacy.server",
        ]
    )
)

a = Analysis(
    [str(ENTRY_SCRIPT)],
    pathex=[str(LOCAL_SERVER_DIR)],
    binaries=[],
    datas=[
        (str(BROWSER_DIST), "browser"),
    ],
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "pytest",
        "httpx",
        "tkinter",
        "_tkinter",
        "matplotlib",
        "numpy",
        "pandas",
        "PIL",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="BinniStore",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ICON_FILE) if ICON_FILE.is_file() else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="BinniStore",
)
