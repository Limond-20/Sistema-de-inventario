#!/usr/bin/env node
/**
 * Herramienta CLI de emisión de licencias sin internet (Bloque J).
 *
 * Genera códigos cortos para enviar por WhatsApp firmados con ECDSA P-256 (SHA-256):
 *   Payload canónico: { idInstalación, plan, emitida, vence }
 *   Formato corto:    BT1.<base64url(payloadJSON)>.<base64url(firmaRaw64Bytes)>
 *
 * IMPORTANTE SOBRE LA CLAVE PRIVADA Y SEGURIDAD EN EL CLIENTE:
 * 1. La clave privada (`private-key.jwk.json`) NUNCA se versiona en Git (está excluida en `.gitignore`).
 * 2. Una licencia verificada localmente en el cliente (sin servidor en la nube) tiene como propósito
 *    DISUADIR copias casuales, manipulación simple del reloj del sistema y recordar la renovación
 *    semestral/anual del servicio y soporte, pero NO es infalible ante un atacante con acceso físico
 *    y permisos de administrador en la PC que modifique el código fuente o reemplace la clave pública.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const LICENSE_TOKEN_PREFIX = 'BT1';
export const VALID_PLANS = ['SEMESTRAL', 'ANUAL'];

function isValidDateYyyyMmDd(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function formatLocalYyyyMmDd(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function computeDefaultExpiryYyyyMmDd(emitidaYyyyMmDd, plan) {
  if (!isValidDateYyyyMmDd(emitidaYyyyMmDd)) {
    throw new Error(`Fecha de emisión inválida: "${emitidaYyyyMmDd}". Usa YYYY-MM-DD.`);
  }
  const normalizedPlan = String(plan || '').trim().toUpperCase();
  if (!VALID_PLANS.includes(normalizedPlan)) {
    throw new Error(`Plan inválido: "${plan}". Valores permitidos: SEMESTRAL, ANUAL.`);
  }
  const [y, m, d] = emitidaYyyyMmDd.split('-').map(Number);
  const monthsToAdd = normalizedPlan === 'ANUAL' ? 12 : 6;
  const targetMonthIndex = m - 1 + monthsToAdd;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const maxDayInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(d, maxDayInTargetMonth);
  const result = new Date(Date.UTC(targetYear, targetMonth, clampedDay));
  const ry = result.getUTCFullYear();
  const rm = String(result.getUTCMonth() + 1).padStart(2, '0');
  const rd = String(result.getUTCDate()).padStart(2, '0');
  return `${ry}-${rm}-${rd}`;
}

export function buildCanonicalPayloadObject(input) {
  const rawId = input?.idInstalación ?? input?.idInstalacion ?? '';
  const idInstalación = String(rawId).trim().toUpperCase();
  if (!idInstalación || idInstalación.length < 4) {
    throw new Error('idInstalación es obligatorio y debe tener al menos 4 caracteres.');
  }

  const plan = String(input?.plan ?? '').trim().toUpperCase();
  if (!VALID_PLANS.includes(plan)) {
    throw new Error(`Plan inválido "${input?.plan}". Debe ser SEMESTRAL o ANUAL.`);
  }

  const emitida = String(input?.emitida || formatLocalYyyyMmDd()).trim();
  if (!isValidDateYyyyMmDd(emitida)) {
    throw new Error(`Fecha "emitida" inválida (${emitida}). Formato esperado: YYYY-MM-DD.`);
  }

  const vence = String(input?.vence || computeDefaultExpiryYyyyMmDd(emitida, plan)).trim();
  if (!isValidDateYyyyMmDd(vence)) {
    throw new Error(`Fecha "vence" inválida (${vence}). Formato esperado: YYYY-MM-DD.`);
  }

  if (vence < emitida) {
    throw new Error(`La fecha de vencimiento (${vence}) no puede ser anterior a la emisión (${emitida}).`);
  }

  return {
    idInstalación,
    plan,
    emitida,
    vence,
  };
}

export async function generateLicenseKeyPairJwk() {
  const { subtle } = globalThis.crypto;
  const keyPair = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const privateJwk = await subtle.exportKey('jwk', keyPair.privateKey);
  const publicJwk = await subtle.exportKey('jwk', keyPair.publicKey);
  return {
    privateKeyJwk: {
      kty: privateJwk.kty,
      crv: privateJwk.crv,
      x: privateJwk.x,
      y: privateJwk.y,
      d: privateJwk.d,
    },
    publicKeyJwk: {
      kty: publicJwk.kty,
      crv: publicJwk.crv,
      x: publicJwk.x,
      y: publicJwk.y,
    },
  };
}

export async function issueLicenseCode(payloadInput, privateKeyJwk) {
  if (!privateKeyJwk || !privateKeyJwk.d || privateKeyJwk.crv !== 'P-256') {
    throw new Error('Se requiere una clave privada ECDSA P-256 en formato JWK válida (con propiedad "d").');
  }
  const canonicalPayload = buildCanonicalPayloadObject(payloadInput);
  const canonicalJson = JSON.stringify(canonicalPayload);
  const payloadBytes = new TextEncoder().encode(canonicalJson);

  const { subtle } = globalThis.crypto;
  const cryptoPrivateKey = await subtle.importKey(
    'jwk',
    privateKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    cryptoPrivateKey,
    payloadBytes
  );

  const payloadB64 = Buffer.from(payloadBytes).toString('base64url');
  const sigB64 = Buffer.from(signatureBuffer).toString('base64url');
  const code = `${LICENSE_TOKEN_PREFIX}.${payloadB64}.${sigB64}`;

  const whatsappMessage = [
    `*Licencia BinniTech (${canonicalPayload.plan})*`,
    `Instalación: ${canonicalPayload.idInstalación}`,
    `Vigencia: ${canonicalPayload.emitida} al ${canonicalPayload.vence}`,
    `Código:`,
    code,
  ].join('\n');

  return {
    code,
    payload: canonicalPayload,
    whatsappMessage,
  };
}

function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--keygen' || token === 'keygen') {
      args.keygen = true;
    } else if (token === '--json') {
      args.json = true;
    } else if (token === '--help' || token === '-h') {
      args.help = true;
    } else if (token === '--id' || token === '--idInstalacion' || token === '--idInstalación') {
      args.idInstalación = argv[++i];
    } else if (token === '--plan') {
      args.plan = argv[++i];
    } else if (token === '--emitida') {
      args.emitida = argv[++i];
    } else if (token === '--vence') {
      args.vence = argv[++i];
    } else if (token === '--key' || token === '--private-key') {
      args.keyPath = argv[++i];
    } else if (token === '--out-dir') {
      args.outDir = argv[++i];
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Uso de license-issuer (Bloque J - ECDSA P-256 sin internet):

1) Generar par de claves ECDSA P-256 (la clave privada NO se versiona):
   node local-server/tools/license-issuer/issue-license.mjs --keygen [--out-dir <carpeta>]

2) Emitir un código de licencia corto para WhatsApp:
   node local-server/tools/license-issuer/issue-license.mjs \\
     --id BT-XXXX-XXXX-XXXX \\
     --plan SEMESTRAL|ANUAL \\
     [--emitida YYYY-MM-DD] \\
     [--vence YYYY-MM-DD] \\
     [--key ruta/a/private-key.jwk.json] \\
     [--json]
`);
}

async function runCli() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.keygen) {
    const outDir = args.outDir ? path.resolve(args.outDir) : __dirname;
    fs.mkdirSync(outDir, { recursive: true });
    const privPath = path.join(outDir, 'private-key.jwk.json');
    const pubPath = path.join(outDir, 'public-key.jwk.json');

    const { privateKeyJwk, publicKeyJwk } = await generateLicenseKeyPairJwk();
    fs.writeFileSync(privPath, JSON.stringify(privateKeyJwk, null, 2) + '\n', { mode: 0o600 });
    fs.writeFileSync(pubPath, JSON.stringify(publicKeyJwk, null, 2) + '\n');

    if (args.json) {
      console.log(JSON.stringify({ privateKeyPath: privPath, publicKeyPath: pubPath, publicKeyJwk }, null, 2));
    } else {
      console.log(`Clave privada guardada en (NO versionar en Git): ${privPath}`);
      console.log(`Clave pública guardada en: ${pubPath}`);
      console.log(`JWK Público para incrustar en license.ts:\n${JSON.stringify(publicKeyJwk)}`);
    }
    return;
  }

  if (!args.idInstalación || !args.plan) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  let privateKeyJwk = null;
  if (process.env.LICENSE_PRIVATE_KEY_JWK) {
    privateKeyJwk = JSON.parse(process.env.LICENSE_PRIVATE_KEY_JWK);
  } else {
    const keyPath = args.keyPath
      ? path.resolve(args.keyPath)
      : path.join(__dirname, 'private-key.jwk.json');
    if (!fs.existsSync(keyPath)) {
      console.error(
        `Error: No se encontró la clave privada en ${keyPath}. Ejecuta primero con --keygen o especifica --key <archivo>.`
      );
      process.exitCode = 1;
      return;
    }
    privateKeyJwk = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
  }

  const result = await issueLicenseCode(
    {
      idInstalación: args.idInstalación,
      plan: args.plan,
      emitida: args.emitida,
      vence: args.vence,
    },
    privateKeyJwk
  );

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.whatsappMessage);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  runCli().catch((err) => {
    console.error(`Error en license-issuer: ${err.message || err}`);
    process.exitCode = 1;
  });
}
