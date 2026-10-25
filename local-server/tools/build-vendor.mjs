// Copia a abarrotes-app/public/vendor las librerías (con versión fija) que necesitan las pantallas
// para funcionar SIN internet, y compila el CSS de la página móvil.
//   cd local-server/tools && npm install && npm run build
// Para verificar que el CSS esté al día sin modificar nada:
//   node build-vendor.mjs --check
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const nm = (p) => join(here, 'node_modules', p);
const out = join(here, '..', '..', 'abarrotes-app', 'public', 'vendor');
const pkgVersion = (name) => JSON.parse(readFileSync(nm(join(name, 'package.json')), 'utf8')).version;

function compileMovilCss(targetFile) {
  const cssIn = join(here, 'movil.input.css');
  writeFileSync(cssIn, '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
  const twBin = process.platform === 'win32' ? nm('.bin/tailwindcss.cmd') : nm('.bin/tailwindcss');
  const configPath = join(here, 'tailwind.movil.config.cjs');

  if (process.platform === 'win32') {
    execSync(`"${twBin}" -c "${configPath}" -i "${cssIn}" -o "${targetFile}" --minify`, {
      cwd: here,
      stdio: 'pipe',
    });
  } else {
    execFileSync(twBin, ['-c', configPath, '-i', cssIn, '-o', targetFile, '--minify'], {
      cwd: here,
      stdio: 'pipe',
    });
  }
}

if (process.argv.includes('--check')) {
  const currentCssPath = join(out, 'movil.css');
  if (!existsSync(currentCssPath)) {
    console.error('Falta vendor/movil.css');
    process.exit(1);
  }
  const currentContent = readFileSync(currentCssPath, 'utf8');
  const tmpCss = join(here, '.tmp.check.css');
  try {
    compileMovilCss(tmpCss);
    const newContent = readFileSync(tmpCss, 'utf8');
    rmSync(tmpCss, { force: true });
    if (currentContent !== newContent) {
      console.error('vendor/movil.css difiere del recompilado');
      process.exit(1);
    }
    console.log('vendor/movil.css está al día');
    process.exit(0);
  } catch (err) {
    rmSync(tmpCss, { force: true });
    console.error('Error al compilar CSS para verificación:', err.message);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'tesseract', 'core'), { recursive: true });
mkdirSync(join(out, 'tesseract', 'lang'), { recursive: true });
mkdirSync(join(out, 'LICENSES'), { recursive: true });

// Lector de códigos de barras / QR
cpSync(nm('html5-qrcode/html5-qrcode.min.js'), join(out, 'html5-qrcode.min.js'));

// OCR (Tesseract.js): script, worker, núcleo WASM (con y sin SIMD) y modelo en español
cpSync(nm('tesseract.js/dist/tesseract.min.js'), join(out, 'tesseract', 'tesseract.min.js'));
cpSync(nm('tesseract.js/dist/worker.min.js'), join(out, 'tesseract', 'worker.min.js'));
for (const f of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']) {
  cpSync(nm(join('tesseract.js-core', f)), join(out, 'tesseract', 'core', f));
}
cpSync(nm('@tesseract.js-data/spa/4.0.0_best_int/spa.traineddata.gz'), join(out, 'tesseract', 'lang', 'spa.traineddata.gz'));

// CSS de la página móvil (misma versión de Tailwind que usaba el CDN: 3.x)
compileMovilCss(join(out, 'movil.css'));

// Licencias y versiones
for (const [pkg, file] of [['html5-qrcode', 'LICENSE'], ['tesseract.js', 'LICENSE.md'], ['tesseract.js-core', 'LICENSE'], ['@tesseract.js-data/spa', 'LICENSE'], ['tailwindcss', 'LICENSE']]) {
  const src = nm(join(pkg, file));
  if (existsSync(src)) cpSync(src, join(out, 'LICENSES', pkg.replace('/', '__') + '.LICENSE'));
}
writeFileSync(join(out, 'README.md'),
`# vendor (generado)

Archivos generados por \`local-server/tools/build-vendor.mjs\`. No editar a mano.

| Archivo | Paquete | Versión |
|---|---|---|
| html5-qrcode.min.js | html5-qrcode | ${pkgVersion('html5-qrcode')} |
| tesseract/*.js, tesseract/core/* | tesseract.js / tesseract.js-core | ${pkgVersion('tesseract.js')} / ${pkgVersion('tesseract.js-core')} |
| tesseract/lang/spa.traineddata.gz | @tesseract.js-data/spa (4.0.0_best_int) | ${pkgVersion('@tesseract.js-data/spa')} |
| movil.css | tailwindcss (compilado) | ${pkgVersion('tailwindcss')} |

Las licencias están en \`LICENSES/\`.
`);
console.log('vendor listo en', out);
