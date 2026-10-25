"""Prueba de frescura del CSS móvil y de integridad de las librerías locales."""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "local-server" / "tools"
VENDOR = ROOT / "abarrotes-app" / "public" / "vendor"
MOVIL_CSS = VENDOR / "movil.css"


def test_vendor_css_fresco():
    """Ejecuta 'node build-vendor.mjs --check' y falla si vendor/movil.css difiere del recompilado."""
    res = subprocess.run(
        ["node", "build-vendor.mjs", "--check"],
        cwd=TOOLS,
        capture_output=True,
        text=True,
    )
    assert res.returncode == 0, (
        f"vendor/movil.css difiere del recompilado a partir de movil-prototipo.html.\n"
        f"STDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}\n"
        f"Ejecuta 'cd local-server/tools && npm run build' para actualizarlo."
    )


def test_vendor_archivos_existen():
    assert VENDOR.is_dir(), "Falta la carpeta vendor/"
    assert MOVIL_CSS.is_file(), "Falta vendor/movil.css"
    assert (VENDOR / "html5-qrcode.min.js").is_file(), "Falta html5-qrcode.min.js"
    assert (VENDOR / "tesseract" / "tesseract.min.js").is_file(), "Falta tesseract.min.js"
    assert (VENDOR / "tesseract" / "lang" / "spa.traineddata.gz").is_file(), "Falta spa.traineddata.gz"
    assert MOVIL_CSS.stat().st_size > 1024, "vendor/movil.css está vacío o corrupto"
