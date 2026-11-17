import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DEMO_LICENSE_CODE,
  DEFAULT_EMBEDDED_PUBLIC_KEY_JWK,
  DEFAULT_INSTALLATION_ID,
  CLIENT_LICENSE_HONEST_DISCLOSURE,
  generateInstallationId,
  generateLicenseKeyPair,
  signLicensePayload,
  parseLicenseCode,
  verifyLicenseSignature,
  evaluateLicenseStatus,
  validateAndActivateLicense,
  bytesToBase64Url,
  base64UrlToBytes,
} from './license.ts';
import { createKardexEntry } from './kardex.ts';
import {
  issueLicenseCode,
  generateLicenseKeyPairJwk,
} from '../../../../local-server/tools/license-issuer/issue-license.mjs';

test('Licencia (Bloque J): Licencia pre-firmada de demostración e ID de instalación aleatorio', async () => {
  const randomId = generateInstallationId();
  assert.match(randomId, /^BT-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const sigCheck = await verifyLicenseSignature(
    DEFAULT_DEMO_LICENSE_CODE,
    DEFAULT_EMBEDDED_PUBLIC_KEY_JWK
  );
  assert.equal(sigCheck.valid, true);
  assert.equal(sigCheck.payload?.idInstalación, DEFAULT_INSTALLATION_ID);
  assert.equal(sigCheck.payload?.plan, 'ANUAL');

  const evalRes = await evaluateLicenseStatus({
    licenseCode: DEFAULT_DEMO_LICENSE_CODE,
    installationId: DEFAULT_INSTALLATION_ID,
    now: '2026-11-17T12:00:00.000Z',
  });
  assert.equal(evalRes.status, 'ACTIVA');
  assert.equal(evalRes.isReadOnly, false);
  assert.equal(evalRes.canSell, true);
  assert.equal(evalRes.canExportAndBackup, true);
  assert.equal(evalRes.warningBanner, null);
  assert.ok(CLIENT_LICENSE_HONEST_DISCLOSURE.summary.includes('no es infalible'));
});

test('Licencia (Bloque J): Compatibilidad directa con CLI license-issuer y mensaje de WhatsApp', async () => {
  const { privateKeyJwk, publicKeyJwk } = await generateLicenseKeyPairJwk();
  const installationId = 'BT-7K9M-4P2Q-8R5T';

  const issued = await issueLicenseCode(
    {
      idInstalación: installationId,
      plan: 'SEMESTRAL',
      emitida: '2026-11-17',
    },
    privateKeyJwk
  );

  assert.equal(issued.payload.idInstalación, installationId);
  assert.equal(issued.payload.plan, 'SEMESTRAL');
  assert.equal(issued.payload.emitida, '2026-11-17');
  assert.equal(issued.payload.vence, '2027-05-17');
  assert.ok(issued.whatsappMessage.includes(issued.code));

  // Verificar pegando el mensaje completo de WhatsApp con texto envolvente
  const evalFromWhatsApp = await evaluateLicenseStatus({
    licenseCode: issued.whatsappMessage,
    installationId,
    now: '2026-11-17T14:00:00.000Z',
    publicKeyJwk,
  });

  assert.equal(evalFromWhatsApp.validSignature, true);
  assert.equal(evalFromWhatsApp.installationMatched, true);
  assert.equal(evalFromWhatsApp.status, 'ACTIVA');
  assert.equal(evalFromWhatsApp.isReadOnly, false);
  assert.equal(evalFromWhatsApp.canSell, true);
});

test('Licencia (Bloque J): Aviso 15 días antes de vencer, 7 días de gracia y modo solo lectura tras vencer', async () => {
  const { privateKeyJwk, publicKeyJwk } = await generateLicenseKeyPair();
  const installationId = 'BT-ABCD-2345-EFGH';

  const code = await signLicensePayload(
    {
      idInstalación: installationId,
      plan: 'SEMESTRAL',
      emitida: '2026-06-01',
      vence: '2026-12-01',
    },
    privateKeyJwk
  );

  // 1) 16 días antes de vencer (2026-11-15) -> ACTIVA sin aviso
  const active16d = await evaluateLicenseStatus({
    licenseCode: code,
    installationId,
    now: new Date(2026, 10, 15, 10, 0, 0),
    publicKeyJwk,
  });
  assert.equal(active16d.status, 'ACTIVA');
  assert.equal(active16d.daysRemaining, 16);
  assert.equal(active16d.warningBanner, null);
  assert.equal(active16d.isReadOnly, false);

  // 2) Exactamente 15 días antes de vencer (2026-11-16) -> POR_VENCER con aviso, puede vender
  const warn15d = await evaluateLicenseStatus({
    licenseCode: code,
    installationId,
    now: new Date(2026, 10, 16, 10, 0, 0),
    publicKeyJwk,
  });
  assert.equal(warn15d.status, 'POR_VENCER');
  assert.equal(warn15d.daysRemaining, 15);
  assert.ok(warn15d.warningBanner?.includes('vence en 15 días'));
  assert.equal(warn15d.isReadOnly, false);
  assert.equal(warn15d.canSell, true);

  // 3) Día del vencimiento (2026-12-01) -> POR_VENCER ("vence HOY"), aún puede vender
  const warnToday = await evaluateLicenseStatus({
    licenseCode: code,
    installationId,
    now: new Date(2026, 11, 1, 18, 0, 0),
    publicKeyJwk,
  });
  assert.equal(warnToday.status, 'POR_VENCER');
  assert.equal(warnToday.daysRemaining, 0);
  assert.ok(warnToday.warningBanner?.includes('vence HOY'));
  assert.equal(warnToday.isReadOnly, false);

  // 4) 1 día después de vencer (2026-12-02) -> PERIODO_GRACIA (quedan 7 días de gracia), aún puede vender
  const graceDay1 = await evaluateLicenseStatus({
    licenseCode: code,
    installationId,
    now: new Date(2026, 11, 2, 10, 0, 0),
    publicKeyJwk,
  });
  assert.equal(graceDay1.status, 'PERIODO_GRACIA');
  assert.equal(graceDay1.daysRemaining, -1);
  assert.equal(graceDay1.graceDaysRemaining, 7);
  assert.equal(graceDay1.isReadOnly, false);
  assert.equal(graceDay1.canSell, true);

  // 5) 7mo día después de vencer (2026-12-08) -> Último día de PERIODO_GRACIA (queda 1 día), aún puede vender
  const graceDay7 = await evaluateLicenseStatus({
    licenseCode: code,
    installationId,
    now: new Date(2026, 11, 8, 10, 0, 0),
    publicKeyJwk,
  });
  assert.equal(graceDay7.status, 'PERIODO_GRACIA');
  assert.equal(graceDay7.daysRemaining, -7);
  assert.equal(graceDay7.graceDaysRemaining, 1);
  assert.equal(graceDay7.isReadOnly, false);
  assert.equal(graceDay7.canSell, true);

  // 6) 8vo día después de vencer (2026-12-09) -> Gracia agotada -> VENCIDA (modo solo lectura: exportar/respaldar sí, vender no)
  const expiredReadOnly = await evaluateLicenseStatus({
    licenseCode: code,
    installationId,
    now: new Date(2026, 11, 9, 10, 0, 0),
    publicKeyJwk,
  });
  assert.equal(expiredReadOnly.status, 'VENCIDA');
  assert.equal(expiredReadOnly.daysRemaining, -8);
  assert.equal(expiredReadOnly.graceDaysRemaining, 0);
  assert.equal(expiredReadOnly.isReadOnly, true);
  assert.equal(expiredReadOnly.canSell, false);
  assert.equal(expiredReadOnly.canExportAndBackup, true);
  assert.ok(expiredReadOnly.readOnlyReason?.includes('Modo solo lectura activo'));
});

test('Licencia (Bloque J): Rechazo de firma alterada y rechazo de ID de otra instalación', async () => {
  const { privateKeyJwk, publicKeyJwk } = await generateLicenseKeyPair();
  const storeA = 'BT-TIEN-DAA1-0001';
  const storeB = 'BT-TIEN-DAB2-9999';

  const validCodeForA = await signLicensePayload(
    {
      idInstalación: storeA,
      plan: 'ANUAL',
      emitida: '2026-11-01',
      vence: '2027-11-01',
    },
    privateKeyJwk
  );

  // Caso 1: Alterar el payload (extender fecha de vencimiento sin clave privada)
  const parsed = parseLicenseCode(validCodeForA);
  assert.equal(parsed.ok, true);
  const tamperedPayloadJson = JSON.stringify({
    idInstalación: storeA,
    plan: 'ANUAL',
    emitida: '2026-11-01',
    vence: '2099-12-31',
  });
  const tamperedPayloadB64 = bytesToBase64Url(new TextEncoder().encode(tamperedPayloadJson));
  const origParts = validCodeForA.split('.');
  const tamperedCode = `BT1.${tamperedPayloadB64}.${origParts[2]}`;

  const tamperedEval = await evaluateLicenseStatus({
    licenseCode: tamperedCode,
    installationId: storeA,
    now: new Date(2026, 10, 17, 12, 0, 0),
    publicKeyJwk,
  });
  assert.equal(tamperedEval.validSignature, false);
  assert.equal(tamperedEval.status, 'INVALIDA');
  assert.equal(tamperedEval.isReadOnly, true);
  assert.equal(tamperedEval.canSell, false);

  // Caso 2: Alterar 1 byte de la firma ECDSA
  const sigBytes = base64UrlToBytes(origParts[2]);
  sigBytes[0] ^= 0xff;
  const corruptedSigCode = `BT1.${origParts[1]}.${bytesToBase64Url(sigBytes)}`;
  const corruptedSigEval = await evaluateLicenseStatus({
    licenseCode: corruptedSigCode,
    installationId: storeA,
    now: new Date(2026, 10, 17, 12, 0, 0),
    publicKeyJwk,
  });
  assert.equal(corruptedSigEval.validSignature, false);
  assert.equal(corruptedSigEval.status, 'INVALIDA');
  assert.equal(corruptedSigEval.isReadOnly, true);

  // Caso 3: Código con firma válida pero emitido para otra instalación (storeA usado en storeB)
  const wrongStoreEval = await evaluateLicenseStatus({
    licenseCode: validCodeForA,
    installationId: storeB,
    now: new Date(2026, 10, 17, 12, 0, 0),
    publicKeyJwk,
  });
  assert.equal(wrongStoreEval.validSignature, true);
  assert.equal(wrongStoreEval.installationMatched, false);
  assert.equal(wrongStoreEval.status, 'INVALIDA');
  assert.equal(wrongStoreEval.isReadOnly, true);
  assert.equal(wrongStoreEval.canSell, false);
  assert.ok(wrongStoreEval.readOnlyReason?.includes(storeA));
});

test('Licencia (Bloque J): Detección de retroceso del reloj (> 5 minutos) usando fecha máxima vista y Kardex encadenado', async () => {
  const { privateKeyJwk, publicKeyJwk } = await generateLicenseKeyPair();
  const installationId = 'BT-RELO-J777-TEST';

  const validCode = await signLicensePayload(
    {
      idInstalación: installationId,
      plan: 'ANUAL',
      emitida: '2026-10-01',
      vence: '2027-10-01',
    },
    privateKeyJwk
  );

  // Entrada en el Kardex encadenado registrada a las 15:00:00Z
  const kardexEntry = createKardexEntry(
    {
      type: 'VENTA_EFECTIVO',
      producto: { sku: 'LAC-LAL-1L', name: 'Leche Lala 1L' },
      cantidad: -1,
      saldoAnterior: 10,
      saldoResultante: 9,
      usuario: 'Don Lupe',
      referencia: 'V-1001',
      timestamp: '2026-11-17T15:00:00.000Z',
    },
    'GENESIS'
  );

  // 1) Atraso de 4 minutos (14:56:00Z vs 15:00:00Z en Kardex) -> Dentro de la tolerancia de 5 minutos
  const withinTolerance = await evaluateLicenseStatus({
    licenseCode: validCode,
    installationId,
    now: '2026-11-17T14:56:00.000Z',
    kardexEntries: [kardexEntry],
    publicKeyJwk,
  });
  assert.equal(withinTolerance.clockRollbackDetected, false);
  assert.equal(withinTolerance.status, 'ACTIVA');
  assert.equal(withinTolerance.isReadOnly, false);

  // 2) Atraso de 6 minutos (14:54:00Z vs 15:00:00Z en Kardex) -> Excede 5 minutos -> MODO SOLO LECTURA
  const rollbackFromKardex = await evaluateLicenseStatus({
    licenseCode: validCode,
    installationId,
    now: '2026-11-17T14:54:00.000Z',
    kardexEntries: [kardexEntry],
    publicKeyJwk,
  });
  assert.equal(rollbackFromKardex.clockRollbackDetected, true);
  assert.equal(rollbackFromKardex.status, 'RELOJ_RETROCEDIDO');
  assert.equal(rollbackFromKardex.isReadOnly, true);
  assert.equal(rollbackFromKardex.canSell, false);
  assert.equal(rollbackFromKardex.canExportAndBackup, true);
  assert.equal(rollbackFromKardex.clockRollbackMinutes, 6);
  assert.ok(rollbackFromKardex.warningBanner?.includes('retroceso en el reloj'));

  // 3) Cuando el reloj vuelve hacia adelante (15:05:00Z), sale del modo solo lectura y actualiza maxObservedTimestampIso
  const recoveredClock = await evaluateLicenseStatus({
    licenseCode: validCode,
    installationId,
    now: '2026-11-17T15:05:00.000Z',
    maxObservedTimestampIso: rollbackFromKardex.maxObservedTimestampIso,
    kardexEntries: [kardexEntry],
    publicKeyJwk,
  });
  assert.equal(recoveredClock.clockRollbackDetected, false);
  assert.equal(recoveredClock.status, 'ACTIVA');
  assert.equal(recoveredClock.isReadOnly, false);
  assert.equal(recoveredClock.maxObservedTimestampIso, '2026-11-17T15:05:00.000Z');
});

test('Licencia (Bloque J): Renovación desde estado vencido restablece operación normal y bloquea downgrade', async () => {
  const { privateKeyJwk, publicKeyJwk } = await generateLicenseKeyPair();
  const installationId = 'BT-RENO-V888-2026';

  const expiredCode = await signLicensePayload(
    {
      idInstalación: installationId,
      plan: 'SEMESTRAL',
      emitida: '2026-01-01',
      vence: '2026-07-01',
    },
    privateKeyJwk
  );

  // El 2026-11-17 la licencia semestral anterior lleva meses vencida (modo solo lectura)
  const beforeRenewal = await evaluateLicenseStatus({
    licenseCode: expiredCode,
    installationId,
    now: new Date(2026, 10, 17, 12, 0, 0),
    publicKeyJwk,
  });
  assert.equal(beforeRenewal.status, 'VENCIDA');
  assert.equal(beforeRenewal.isReadOnly, true);
  assert.equal(beforeRenewal.canSell, false);

  // Emitir nuevo código ANUAL y activar renovación
  const renewedCode = await signLicensePayload(
    {
      idInstalación: installationId,
      plan: 'ANUAL',
      emitida: '2026-11-17',
      vence: '2027-11-17',
    },
    privateKeyJwk
  );

  const activation = await validateAndActivateLicense({
    newLicenseCode: renewedCode,
    installationId,
    currentPayload: beforeRenewal.payload,
    now: new Date(2026, 10, 17, 12, 0, 0),
    publicKeyJwk,
  });
  assert.equal(activation.ok, true);
  assert.equal(activation.evaluation.status, 'ACTIVA');
  assert.equal(activation.evaluation.isReadOnly, false);
  assert.equal(activation.evaluation.canSell, true);
  assert.equal(activation.updatedRecord?.licenseCode, renewedCode);

  // Intentar volver a meter el código viejo (downgrade) debe ser rechazado
  const downgradeAttempt = await validateAndActivateLicense({
    newLicenseCode: expiredCode,
    installationId,
    currentPayload: activation.evaluation.payload,
    now: new Date(2026, 10, 17, 12, 0, 0),
    publicKeyJwk,
  });
  assert.equal(downgradeAttempt.ok, false);
});
