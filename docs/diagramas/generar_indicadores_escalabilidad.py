"""Script para generar y optimizar la imagen 'Indicadores y escalabilidad'

Requisitos cumplidos:
- Formato PNG, 1920 x 1080 px, horizontal.
- Peso menor a 480,000 bytes (concurso <= 500 KB).
- Renderizado de alta fidelidad vía Chrome headless + optimización con Pillow.
"""
import os
import subprocess
import sys
from pathlib import Path
from PIL import Image

def generar_indicadores_escalabilidad():
    sys.stdout.reconfigure(encoding='utf-8')
    base_dir = Path(__file__).resolve().parent
    html_file = base_dir / "indicadores_escalabilidad.html"
    salida_dir = base_dir / "salida"
    salida_dir.mkdir(parents=True, exist_ok=True)
    
    raw_png = salida_dir / "raw_indicadores_escalabilidad.png"
    final_png = salida_dir / "indicadores_escalabilidad.png"

    chrome_paths = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    browser_bin = None
    for p in chrome_paths:
        if os.path.exists(p):
            browser_bin = p
            break

    if not browser_bin:
        raise FileNotFoundError("No se encontró Google Chrome ni Microsoft Edge para renderizar.")

    html_uri = html_file.as_uri()
    print(f"Renderizando con navegador headless: {browser_bin}")
    print(f"Origen HTML: {html_uri}")

    cmd = [
        browser_bin,
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        f"--screenshot={str(raw_png)}",
        "--window-size=1920,1080",
        "--default-background-color=00000000",
        html_uri
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not raw_png.exists():
        print("Error en captura headless:", result.stderr)
        sys.exit(1)

    print(f"Captura base generada: {raw_png} ({raw_png.stat().st_size} bytes)")

    # Procesar y optimizar con Pillow
    with Image.open(raw_png) as img:
        if img.size != (1920, 1080):
            print(f"Ajustando dimensiones de {img.size} a (1920, 1080)")
            img = img.resize((1920, 1080), Image.Resampling.LANCZOS)
        
        if img.mode != "RGB":
            rgb_img = Image.new("RGB", (1920, 1080), (255, 247, 234))
            rgb_img.paste(img, mask=img.split()[3] if len(img.split()) == 4 else None)
            img = rgb_img

        for color_count in [256, 128, 96, 64]:
            quantized = img.quantize(colors=color_count, method=Image.Quantize.MEDIANCUT)
            tmp_save = salida_dir / f"tmp_quant_ie_{color_count}.png"
            quantized.save(str(tmp_save), format="PNG", optimize=True)
            size = tmp_save.stat().st_size
            print(f"Prueba con {color_count} colores -> {size:,} bytes")
            if size < 480000:
                if final_png.exists():
                    try:
                        final_png.unlink()
                    except Exception:
                        pass
                tmp_save.replace(final_png)
                break
            else:
                tmp_save.unlink()

    final_size = final_png.stat().st_size
    print("\n--- RESULTADO FINAL ---")
    print(f"Ruta: {final_png.resolve()}")
    print(f"Dimensiones: {Image.open(final_png).size[0]} x {Image.open(final_png).size[1]} px")
    print(f"Peso final: {final_size:,} bytes ({final_size / 1024:.2f} KB)")
    
    if final_size < 480000:
        print("Cumple con la regla de peso (< 480,000 bytes)")
    else:
        print("ADVERTENCIA: Excede el peso límite de 480,000 bytes")

    if raw_png.exists():
        raw_png.unlink()

if __name__ == "__main__":
    generar_indicadores_escalabilidad()
