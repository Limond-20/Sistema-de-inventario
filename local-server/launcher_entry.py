"""Punto de entrada del ejecutable autónomo BinniTech-POS.exe (modo sin consola).

- Se ejecuta en modo GUI sin ventana negra de CMD (--noconsole).
- Mantiene en la carpeta junto al ejecutable únicamente `Respaldos` y `Evidencias`,
  y oculta automáticamente `_internal` con el atributo Hidden de Windows.
- Guarda las carpetas técnicas (`data`, `certs`, `navegador`, `inventory.sqlite3`
  y `servidor.log`) en `%LOCALAPPDATA%\\BinniTech-POS`.
- Abre la ventana dedicada de la aplicación (`--app` + `--test-type`) sin robar
  el foco de los campos de texto y confirma el cierre a nivel nativo Win32.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

# Importaciones explícitas para que PyInstaller incluya los submódulos dinámicos de Uvicorn/FastAPI
import cryptography  # noqa: F401
import fastapi  # noqa: F401
import segno  # noqa: F401
import sqlite3  # noqa: F401
import uvicorn  # noqa: F401
import uvicorn.lifespan.off  # noqa: F401
import uvicorn.lifespan.on  # noqa: F401
import uvicorn.logging  # noqa: F401
import uvicorn.loops.asyncio  # noqa: F401
import uvicorn.loops.auto  # noqa: F401
import uvicorn.protocols.http.auto  # noqa: F401
import uvicorn.protocols.http.h11_impl  # noqa: F401
import uvicorn.protocols.websockets.auto  # noqa: F401
import uvicorn.protocols.websockets.websockets_impl  # noqa: F401
import websockets  # noqa: F401

from lansync.server import main as lansync_main

MB_YESNO = 0x00000004
MB_ICONQUESTION = 0x00000020
MB_DEFBUTTON2 = 0x00000100
MB_SETFOREGROUND = 0x00010000
MB_TOPMOST = 0x00040000
IDYES = 6

FILE_ATTRIBUTE_HIDDEN = 0x02
INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF

WH_KEYBOARD_LL = 13
WH_MOUSE_LL = 14
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_KEYDOWN = 0x0100
WM_SYSKEYDOWN = 0x0104
VK_F4 = 0x73
VK_MENU = 0x12
GA_ROOT = 2

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

LRESULT = ctypes.c_ssize_t
WPARAM = ctypes.c_size_t
LPARAM = ctypes.c_ssize_t
HOOKPROC = ctypes.WINFUNCTYPE(LRESULT, ctypes.c_int, WPARAM, LPARAM)

user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, wintypes.HINSTANCE, wintypes.DWORD]
user32.SetWindowsHookExW.restype = wintypes.HHOOK
user32.CallNextHookEx.argtypes = [wintypes.HHOOK, ctypes.c_int, WPARAM, LPARAM]
user32.CallNextHookEx.restype = LRESULT
user32.UnhookWindowsHookEx.argtypes = [wintypes.HHOOK]
user32.UnhookWindowsHookEx.restype = wintypes.BOOL
user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
user32.GetMessageW.restype = wintypes.BOOL
user32.WindowFromPoint.argtypes = [wintypes.POINT]
user32.WindowFromPoint.restype = wintypes.HWND
user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
user32.GetAncestor.restype = wintypes.HWND
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetWindowRect.restype = wintypes.BOOL
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetForegroundWindow.argtypes = []
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
user32.GetAsyncKeyState.restype = ctypes.c_short
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, WPARAM, LPARAM]
user32.PostMessageW.restype = wintypes.BOOL
kernel32.GetFileAttributesW.argtypes = [wintypes.LPCWSTR]
kernel32.GetFileAttributesW.restype = wintypes.DWORD
kernel32.SetFileAttributesW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
kernel32.SetFileAttributesW.restype = wintypes.BOOL


class MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("pt", wintypes.POINT),
        ("mouseData", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("vkCode", wintypes.DWORD),
        ("scanCode", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


def hide_windows_directory(path: Path) -> None:
    """Marca un directorio con el atributo Hidden (0x02) de Windows."""
    try:
        if not path.is_dir():
            return
        target = str(path)
        attrs = kernel32.GetFileAttributesW(target)
        new_attrs = FILE_ATTRIBUTE_HIDDEN if attrs == INVALID_FILE_ATTRIBUTES else (attrs | FILE_ATTRIBUTE_HIDDEN)
        kernel32.SetFileAttributesW(target, new_attrs)
    except Exception:
        pass


def ask_confirm_close() -> bool:
    """Muestra únicamente la alerta nativa de Windows preguntando si desea cerrar la aplicación."""
    try:
        flags = MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2 | MB_SETFOREGROUND | MB_TOPMOST
        res = user32.MessageBoxW(
            0,
            "¿Realmente deseas cerrar la aplicación?\n\n"
            "• Sí: Cierra el sistema y detiene el servidor local.\n"
            "• No: Mantiene abierta la aplicación.",
            "Cerrar BinniTech POS",
            flags,
        )
        return res == IDYES
    except Exception:
        return True


def is_app_window(hwnd: int) -> bool:
    if not hwnd:
        return False
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(hwnd, buf, 256)
    title = buf.value or ""
    markers = ("Sistema de Inventario", "Punto de Venta", "Mi Tiendita", "localhost:8443")
    return any(m in title for m in markers)


def find_chromium_browser() -> str | None:
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    return None


def is_port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def start_win32_close_hook(state: dict) -> None:
    """Intercepta clic en la X y Alt+F4 sobre la ventana de la app sin tocar el contenido web."""
    prompt_lock = threading.Lock()
    swallow_next_up = {"flag": False}

    def trigger_close_dialog(hwnd: int) -> None:
        if not prompt_lock.acquire(blocking=False):
            return
        try:
            state["dialog_active"] = True
            if ask_confirm_close():
                state["confirmed_exit"] = True
                WM_CLOSE = 0x0010
                if hwnd:
                    user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
                proc = state.get("proc")
                if proc and proc.poll() is None:
                    try:
                        proc.terminate()
                    except Exception:
                        pass
                time.sleep(0.15)
                os._exit(0)
        finally:
            state["dialog_active"] = False
            prompt_lock.release()

    def mouse_proc(nCode: int, wParam: int, lParam: int) -> int:
        if nCode >= 0 and not state.get("confirmed_exit"):
            if wParam == WM_LBUTTONUP and swallow_next_up["flag"]:
                swallow_next_up["flag"] = False
                return 1
            if wParam == WM_LBUTTONDOWN:
                info = ctypes.cast(lParam, ctypes.POINTER(MSLLHOOKSTRUCT)).contents
                hwnd = user32.WindowFromPoint(info.pt)
                root_hwnd = user32.GetAncestor(hwnd, GA_ROOT) or hwnd
                if is_app_window(root_hwnd):
                    rect = wintypes.RECT()
                    if user32.GetWindowRect(root_hwnd, ctypes.byref(rect)):
                        x, y = info.pt.x, info.pt.y
                        # Área del botón cerrar (X) en la esquina superior derecha de la barra de título
                        if (rect.right - 52) <= x <= rect.right and rect.top <= y <= (rect.top + 42):
                            swallow_next_up["flag"] = True
                            threading.Thread(
                                target=trigger_close_dialog, args=(root_hwnd,), daemon=True
                            ).start()
                            return 1
        return user32.CallNextHookEx(None, nCode, wParam, lParam)

    def kbd_proc(nCode: int, wParam: int, lParam: int) -> int:
        if nCode >= 0 and not state.get("confirmed_exit"):
            if wParam in (WM_KEYDOWN, WM_SYSKEYDOWN):
                info = ctypes.cast(lParam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
                alt_down = (user32.GetAsyncKeyState(VK_MENU) & 0x8000) != 0
                if info.vkCode == VK_F4 and alt_down:
                    fg = user32.GetForegroundWindow()
                    if is_app_window(fg):
                        threading.Thread(
                            target=trigger_close_dialog, args=(fg,), daemon=True
                        ).start()
                        return 1
        return user32.CallNextHookEx(None, nCode, wParam, lParam)

    mouse_cb = HOOKPROC(mouse_proc)
    kbd_cb = HOOKPROC(kbd_proc)
    h_mouse = user32.SetWindowsHookExW(WH_MOUSE_LL, mouse_cb, None, 0)
    h_kbd = user32.SetWindowsHookExW(WH_KEYBOARD_LL, kbd_cb, None, 0)

    msg = wintypes.MSG()
    while not state.get("stop_hooks"):
        ret = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
        if ret <= 0:
            break

    if h_mouse:
        user32.UnhookWindowsHookEx(h_mouse)
    if h_kbd:
        user32.UnhookWindowsHookEx(h_kbd)


def supervise_application_window(url: str, profile_dir: Path) -> None:
    """Espera al servidor HTTPS, abre la ventana limpia (--app + --test-type) y vigila su cierre."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    for _ in range(80):
        try:
            with urllib.request.urlopen(url, context=ctx, timeout=1):
                break
        except Exception:
            time.sleep(0.2)

    browser_bin = find_chromium_browser()
    if not browser_bin:
        webbrowser.open(url)
        return

    profile_dir.mkdir(parents=True, exist_ok=True)
    create_no_window = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)

    state = {"confirmed_exit": False, "dialog_active": False, "stop_hooks": False, "proc": None}
    threading.Thread(target=start_win32_close_hook, args=(state,), daemon=True).start()

    while True:
        try:
            proc = subprocess.Popen(
                [
                    browser_bin,
                    f"--app={url}",
                    f"--user-data-dir={str(profile_dir)}",
                    "--ignore-certificate-errors",
                    "--test-type",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-session-crashed-bubble",
                    "--start-maximized",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=create_no_window,
            )
            state["proc"] = proc
        except Exception:
            webbrowser.open(url)
            return

        proc.wait()

        if state.get("confirmed_exit"):
            state["stop_hooks"] = True
            os._exit(0)

        # Si el usuario cerró la ventana desde la barra de tareas o menú del sistema, confirmar aquí:
        if not state.get("dialog_active"):
            if ask_confirm_close():
                state["stop_hooks"] = True
                os._exit(0)
        # Si eligió "No", el ciclo vuelve a abrir la ventana conservando la sesión.


def setup_logging_streams(data_dir: Path) -> None:
    log_path = data_dir / "servidor.log"
    try:
        log_file = open(log_path, "a", encoding="utf-8", buffering=1)
        sys.stdout = log_file
        sys.stderr = log_file
    except Exception:
        devnull = open(os.devnull, "w", encoding="utf-8")
        sys.stdout = devnull
        sys.stderr = devnull


def _resolve_requested_port(argv: list[str], default: int = 8443) -> int:
    for idx, arg in enumerate(argv):
        if arg == "--port" and idx + 1 < len(argv):
            try:
                return int(argv[idx + 1])
            except ValueError:
                return default
        if arg.startswith("--port="):
            try:
                return int(arg.split("=", 1)[1])
            except ValueError:
                return default
    return default


def run() -> None:
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        bundle_dir = Path(getattr(sys, "_MEIPASS", exe_dir))
    else:
        exe_dir = Path(__file__).resolve().parent
        bundle_dir = exe_dir

    # Ocultar _internal junto al ejecutable para que el usuario final solo vea Respaldos y Evidencias
    hide_windows_directory(exe_dir / "_internal")

    static_dir = exe_dir / "browser"
    if not static_dir.is_dir():
        static_dir = bundle_dir / "browser"

    # Carpetas visibles para el cliente en la raíz junto a BinniTech-POS.exe
    respaldos_dir = exe_dir / "Respaldos"
    evidencias_dir = exe_dir / "Evidencias"
    respaldos_dir.mkdir(parents=True, exist_ok=True)
    evidencias_dir.mkdir(parents=True, exist_ok=True)

    # Carpetas técnicas del sistema en %LOCALAPPDATA%\BinniTech-POS
    local_appdata = Path(os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local"))
    appdata_root = local_appdata / "BinniTech-POS"
    data_dir = appdata_root / "data"
    cert_dir = appdata_root / "certs"
    profile_dir = appdata_root / "navegador"
    data_dir.mkdir(parents=True, exist_ok=True)
    cert_dir.mkdir(parents=True, exist_ok=True)

    setup_logging_streams(data_dir)

    user_args = [a for a in sys.argv[1:] if a != "--no-browser"]
    port = _resolve_requested_port(user_args, 8443)
    url = f"https://localhost:{port}/"

    if is_port_in_use(port):
        if "--no-browser" not in sys.argv:
            supervise_application_window(url, profile_dir)
        return

    if "--no-browser" not in sys.argv:
        threading.Thread(
            target=supervise_application_window,
            args=(url, profile_dir),
            daemon=True,
        ).start()

    default_args = [
        "--host",
        "0.0.0.0",
        "--port",
        str(port),
        "--static",
        str(static_dir),
        "--data-dir",
        str(data_dir),
        "--cert-dir",
        str(cert_dir),
        "--respaldos-dir",
        str(respaldos_dir),
        "--evidencias-dir",
        str(evidencias_dir),
    ]
    lansync_main(default_args + user_args)


if __name__ == "__main__":
    run()
