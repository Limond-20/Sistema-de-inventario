import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryPinStorage,
  isPinConfigured,
  setupInitialPin,
  verifyPinAttempt,
  loadPinState,
  loadPinConfig,
} from './pin.ts';

test('PIN: Obliga a crear el PIN en el primer uso (sin PIN por defecto)', async () => {
  const storage = new MemoryPinStorage();

  // 1. Al inicio no debe haber PIN configurado
  assert.equal(isPinConfigured(storage), false, 'No debe existir un PIN predeterminado');

  // Intento de verificación sin PIN configurado
  const resSinConfig = await verifyPinAttempt('1234', storage);
  assert.equal(resSinConfig.success, false);
  assert.equal(resSinConfig.isFirstUseRequired, true);
  assert.match(resSinConfig.message, /primer uso/i);

  // 2. Se obliga a crear el PIN inicial con PBKDF2 >= 100,000 iteraciones
  const config = await setupInitialPin('7890', storage, 100_000);
  assert.equal(isPinConfigured(storage), true);
  assert.equal(config.iterations, 100_000);
  assert.equal(config.pinHash.length, 64, 'El hash PBKDF2 debe ser de 256 bits (64 hex)');

  // 3. Verificación con el nuevo PIN
  const resExito = await verifyPinAttempt('7890', storage, Date.now(), 'Don Lupe (Dueño)');
  assert.equal(resExito.success, true);
  assert.equal(resExito.authorizedBy, 'Don Lupe (Dueño)');
});

test('PIN: Persiste intentos fallidos y bloqueo (sobreviven a recargar)', async () => {
  // Simulamos el almacenamiento del navegador que sobrevive a recargas
  const sharedBrowserStorage = new MemoryPinStorage();

  await setupInitialPin('4321', sharedBrowserStorage, 100_000, 3, 30_000);
  const t0 = 1_000_000;

  // Intento 1 incorrecto
  const intento1 = await verifyPinAttempt('0000', sharedBrowserStorage, t0);
  assert.equal(intento1.success, false);
  assert.equal(intento1.remainingAttempts, 2);

  // SIMULACIÓN DE RECARGA DE PÁGINA (creamos una nueva instancia sobre el mismo almacenamiento)
  const estadoTrasRecarga1 = loadPinState(sharedBrowserStorage);
  assert.equal(
    estadoTrasRecarga1.failedAttempts,
    1,
    'El intento fallido debe persistir tras recargar'
  );

  // Intento 2 incorrecto
  const intento2 = await verifyPinAttempt('1111', sharedBrowserStorage, t0 + 2000);
  assert.equal(intento2.remainingAttempts, 1);

  // SIMULACIÓN DE SEGUNDA RECARGA DE PÁGINA
  const estadoTrasRecarga2 = loadPinState(sharedBrowserStorage);
  assert.equal(estadoTrasRecarga2.failedAttempts, 2);

  // Intento 3 incorrecto (bloquea por 30 segundos)
  const intento3 = await verifyPinAttempt('9999', sharedBrowserStorage, t0 + 4000);
  assert.equal(intento3.isLocked, true);
  assert.equal(intento3.lockedRemainingSeconds, 30);
  assert.equal(intento3.nextState.lockedUntil, (t0 + 4000) + 30_000);

  // SIMULACIÓN DE RECARGA DURANTE EL BLOQUEO (10 segundos después)
  const intentoDuranteBloqueo = await verifyPinAttempt('4321', sharedBrowserStorage, t0 + 14_000);
  assert.equal(
    intentoDuranteBloqueo.isLocked,
    true,
    'El bloqueo de 30s debe persistir aunque el usuario recargue el navegador'
  );
  assert.equal(intentoDuranteBloqueo.lockedRemainingSeconds, 20);

  // Intento después de que expira el bloqueo (35 segundos después) con PIN correcto
  const intentoLiberado = await verifyPinAttempt('4321', sharedBrowserStorage, t0 + 39_000);
  assert.equal(intentoLiberado.success, true);
  assert.equal(intentoLiberado.isLocked, false);
  assert.equal(intentoLiberado.remainingAttempts, 3);

  // Verificar que el estado guardado se limpió tras el éxito
  const estadoLimpio = loadPinState(sharedBrowserStorage);
  assert.equal(estadoLimpio.failedAttempts, 0);
  assert.equal(estadoLimpio.lockedUntil, null);
});
