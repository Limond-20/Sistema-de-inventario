"""Punto de entrada del ejecutable autónomo BinniStore.exe (modo sin consola).

- Se ejecuta en modo GUI sin ventana negra de CMD (--noconsole).
- Mantiene en la carpeta junto al ejecutable únicamente `Respaldos` y `Evidencias`,
  y oculta automáticamente `_internal` con el atributo Hidden de Windows.
- Guarda las carpetas técnicas (`data`, `certs`, `navegador`, `inventory.sqlite3`
  y `servidor.log`) en `%LOCALAPPDATA%\\BinniStore`.
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
MB_ICONEXCLAMATION = 0x00000030
MB_DEFBUTTON2 = 0x00000100
MB_SYSTEMMODAL = 0x00001000
MB_SETFOREGROUND = 0x00010000
MB_TOPMOST = 0x00040000
IDYES = 6

FILE_ATTRIBUTE_HIDDEN = 0x02
INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF

WH_CBT = 5
WH_KEYBOARD_LL = 13
WH_MOUSE_LL = 14
HCBT_ACTIVATE = 5
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_KEYDOWN = 0x0100
WM_SYSKEYDOWN = 0x0104
VK_F4 = 0x73
VK_MENU = 0x12
GA_ROOT = 2

SW_SHOWNORMAL = 1
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_SHOWWINDOW = 0x0040
HWND_TOPMOST = ctypes.c_void_p(-1)
ASFW_ANY = 0xFFFFFFFF

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
user32.MessageBoxW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.UINT]
user32.MessageBoxW.restype = ctypes.c_int
user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
user32.SetWindowPos.restype = wintypes.BOOL
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.ShowWindow.restype = wintypes.BOOL
user32.BringWindowToTop.argtypes = [wintypes.HWND]
user32.BringWindowToTop.restype = wintypes.BOOL
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.SetForegroundWindow.restype = wintypes.BOOL
user32.SwitchToThisWindow.argtypes = [wintypes.HWND, wintypes.BOOL]
user32.SwitchToThisWindow.restype = None
user32.SetActiveWindow.argtypes = [wintypes.HWND]
user32.SetActiveWindow.restype = wintypes.HWND
user32.AllowSetForegroundWindow.argtypes = [wintypes.DWORD]
user32.AllowSetForegroundWindow.restype = wintypes.BOOL
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
user32.AttachThreadInput.restype = wintypes.BOOL
user32.IsWindow.argtypes = [wintypes.HWND]
user32.IsWindow.restype = wintypes.BOOL
user32.IsZoomed.argtypes = [wintypes.HWND]
user32.IsZoomed.restype = wintypes.BOOL
user32.MessageBeep.argtypes = [wintypes.UINT]
user32.MessageBeep.restype = wintypes.BOOL
if hasattr(user32, "GetDpiForWindow"):
    user32.GetDpiForWindow.argtypes = [wintypes.HWND]
    user32.GetDpiForWindow.restype = wintypes.UINT
if hasattr(user32, "SetProcessDpiAwarenessContext"):
    user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    user32.SetProcessDpiAwarenessContext.restype = wintypes.BOOL
if hasattr(user32, "SetProcessDPIAware"):
    user32.SetProcessDPIAware.argtypes = []
    user32.SetProcessDPIAware.restype = wintypes.BOOL

kernel32.GetCurrentThreadId.argtypes = []
kernel32.GetCurrentThreadId.restype = wintypes.DWORD
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


def enable_dpi_awareness() -> None:
    """Habilita conciencia DPI para que GetWindowRect coincida exactamente con el hook del mouse."""
    try:
        if hasattr(user32, "SetProcessDpiAwarenessContext"):
            if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
                return
        if hasattr(user32, "SetProcessDPIAware"):
            user32.SetProcessDPIAware()
    except Exception:
        pass


def get_window_dpi_scale(hwnd: int) -> float:
    try:
        if hwnd and hasattr(user32, "GetDpiForWindow"):
            dpi = int(user32.GetDpiForWindow(hwnd))
            if dpi > 0:
                return dpi / 96.0
    except Exception:
        pass
    return 1.0


def force_window_to_front(hwnd: int, center_on_hwnd: int = 0) -> None:
    """Trae el diálogo nativo al primer plano sobre Chrome/Edge y le devuelve el foco."""
    try:
        if not hwnd or not user32.IsWindow(hwnd):
            return

        cur_tid = kernel32.GetCurrentThreadId()
        fg_hwnd = user32.GetForegroundWindow()
        fg_tid = user32.GetWindowThreadProcessId(fg_hwnd, None) if fg_hwnd else 0
        dlg_tid = user32.GetWindowThreadProcessId(hwnd, None)

        attached_fg = False
        attached_dlg = False
        try:
            if fg_tid and fg_tid != cur_tid:
                attached_fg = bool(user32.AttachThreadInput(cur_tid, fg_tid, True))
            if dlg_tid and dlg_tid != cur_tid and dlg_tid != fg_tid:
                attached_dlg = bool(user32.AttachThreadInput(cur_tid, dlg_tid, True))

            user32.AllowSetForegroundWindow(ASFW_ANY)
            user32.ShowWindow(hwnd, SW_SHOWNORMAL)

            flags = SWP_NOSIZE | SWP_SHOWWINDOW
            x = 0
            y = 0
            if center_on_hwnd and user32.IsWindow(center_on_hwnd):
                app_rect = wintypes.RECT()
                dlg_rect = wintypes.RECT()
                if user32.GetWindowRect(center_on_hwnd, ctypes.byref(app_rect)) and user32.GetWindowRect(
                    hwnd, ctypes.byref(dlg_rect)
                ):
                    dlg_w = max(1, dlg_rect.right - dlg_rect.left)
                    dlg_h = max(1, dlg_rect.bottom - dlg_rect.top)
                    x = max(0, app_rect.left + ((app_rect.right - app_rect.left - dlg_w) // 2))
                    y = max(0, app_rect.top + ((app_rect.bottom - app_rect.top - dlg_h) // 2))
                else:
                    flags |= SWP_NOMOVE
            else:
                flags |= SWP_NOMOVE

            user32.SetWindowPos(hwnd, HWND_TOPMOST, x, y, 0, 0, flags)
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
            user32.SetActiveWindow(hwnd)
            user32.SwitchToThisWindow(hwnd, True)
        finally:
            if attached_dlg:
                user32.AttachThreadInput(cur_tid, dlg_tid, False)
            if attached_fg:
                user32.AttachThreadInput(cur_tid, fg_tid, False)
    except Exception:
        pass


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


def ask_confirm_close(state: dict | None = None, app_hwnd: int = 0) -> bool:
    """Muestra únicamente la alerta nativa de Windows siempre al frente sobre la ventana de la app."""
    h_cbt = None
    tid = kernel32.GetCurrentThreadId()

    def ensure_front(dlg_hwnd: int) -> None:
        if state is not None and not state.get("dialog_active"):
            return
        force_window_to_front(dlg_hwnd, app_hwnd)

    def cbt_proc(nCode: int, wParam: int, lParam: int) -> int:
        if nCode == HCBT_ACTIVATE and wParam:
            dlg_hwnd = int(wParam)
            if state is not None:
                state["dialog_hwnd"] = dlg_hwnd
            threading.Timer(0.015, ensure_front, args=(dlg_hwnd,)).start()
            threading.Timer(0.08, ensure_front, args=(dlg_hwnd,)).start()
            threading.Timer(0.20, ensure_front, args=(dlg_hwnd,)).start()
        return user32.CallNextHookEx(h_cbt, nCode, wParam, lParam)

    cbt_cb = HOOKPROC(cbt_proc)
    try:
        h_cbt = user32.SetWindowsHookExW(WH_CBT, cbt_cb, None, tid)
        flags = MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2 | MB_SYSTEMMODAL | MB_SETFOREGROUND | MB_TOPMOST
        res = user32.MessageBoxW(
            0,
            "¿Realmente deseas cerrar la aplicación?\n\n"
            "• Sí: Cierra el sistema y detiene el servidor local.\n"
            "• No: Mantiene abierta la aplicación.",
            "Cerrar BinniStore",
            flags,
        )
        return res == IDYES
    except Exception:
        return True
    finally:
        if state is not None:
            state["dialog_hwnd"] = 0
        if h_cbt:
            user32.UnhookWindowsHookEx(h_cbt)


def is_app_window(hwnd: int) -> bool:
    if not hwnd:
        return False
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(hwnd, buf, 256)
    title = buf.value or ""
    markers = ("BinniStore", "Sistema de Inventario", "Punto de Venta", "Mi Tiendita", "localhost:8443")
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
    swallow_next_up = {"flag": False, "close_hwnd": 0}

    def notify_and_focus_dialog(dlg_hwnd: int, app_hwnd: int) -> None:
        try:
            user32.MessageBeep(MB_ICONEXCLAMATION)
        except Exception:
            pass
        force_window_to_front(dlg_hwnd, app_hwnd)

    def trigger_close_dialog(hwnd: int) -> None:
        if not prompt_lock.acquire(blocking=False):
            dlg_hwnd = int(state.get("dialog_hwnd") or 0)
            if dlg_hwnd:
                notify_and_focus_dialog(dlg_hwnd, hwnd)
            return
        try:
            state["dialog_active"] = True
            if ask_confirm_close(state, hwnd):
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
            elif hwnd and user32.IsWindow(hwnd):
                user32.SetForegroundWindow(hwnd)
        finally:
            state["dialog_active"] = False
            state["dialog_hwnd"] = 0
            prompt_lock.release()

    def mouse_proc(nCode: int, wParam: int, lParam: int) -> int:
        if nCode >= 0 and not state.get("confirmed_exit"):
            if wParam == WM_LBUTTONUP and swallow_next_up["flag"]:
                close_hwnd = int(swallow_next_up.get("close_hwnd") or 0)
                swallow_next_up["flag"] = False
                swallow_next_up["close_hwnd"] = 0
                if close_hwnd:
                    threading.Thread(
                        target=trigger_close_dialog, args=(close_hwnd,), daemon=True
                    ).start()
                return 1
            if wParam == WM_LBUTTONDOWN:
                info = ctypes.cast(lParam, ctypes.POINTER(MSLLHOOKSTRUCT)).contents
                hwnd = user32.WindowFromPoint(info.pt)
                root_hwnd = user32.GetAncestor(hwnd, GA_ROOT) or hwnd
                if is_app_window(root_hwnd):
                    # Si el diálogo ya está abierto, bloquear clic en la app y traerlo al frente
                    if state.get("dialog_active"):
                        swallow_next_up["flag"] = True
                        swallow_next_up["close_hwnd"] = 0
                        dlg_hwnd = int(state.get("dialog_hwnd") or 0)
                        if dlg_hwnd:
                            threading.Thread(
                                target=notify_and_focus_dialog, args=(dlg_hwnd, root_hwnd), daemon=True
                            ).start()
                        return 1

                    rect = wintypes.RECT()
                    if user32.GetWindowRect(root_hwnd, ctypes.byref(rect)):
                        x, y = info.pt.x, info.pt.y
                        scale = get_window_dpi_scale(root_hwnd)
                        zoomed = bool(user32.IsZoomed(root_hwnd))
                        close_w = int(round((62 if zoomed else 56) * scale))
                        title_h = int(round((50 if zoomed else 46) * scale))
                        # Área del botón cerrar (X) en la esquina superior derecha de la barra de título
                        if (rect.right - close_w) <= x <= rect.right and rect.top <= y <= (rect.top + title_h):
                            swallow_next_up["flag"] = True
                            swallow_next_up["close_hwnd"] = int(root_hwnd)
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
                        if state.get("dialog_active"):
                            dlg_hwnd = int(state.get("dialog_hwnd") or 0)
                            if dlg_hwnd:
                                threading.Thread(
                                    target=notify_and_focus_dialog, args=(dlg_hwnd, fg), daemon=True
                                ).start()
                            return 1
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

    state = {
        "confirmed_exit": False,
        "dialog_active": False,
        "dialog_hwnd": 0,
        "stop_hooks": False,
        "proc": None,
    }
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
            state["dialog_active"] = True
            try:
                if ask_confirm_close(state, 0):
                    state["stop_hooks"] = True
                    os._exit(0)
            finally:
                state["dialog_active"] = False
                state["dialog_hwnd"] = 0
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
    enable_dpi_awareness()

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

    # Carpetas visibles para el cliente en la raíz junto a BinniStore.exe
    respaldos_dir = exe_dir / "Respaldos"
    evidencias_dir = exe_dir / "Evidencias"
    respaldos_dir.mkdir(parents=True, exist_ok=True)
    evidencias_dir.mkdir(parents=True, exist_ok=True)

    # Carpetas técnicas de la versión de demostración en %LOCALAPPDATA%\BinniStore-Demo
    local_appdata = Path(os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local"))
    appdata_root = local_appdata / "BinniStore-Demo"
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
