import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupInitialPin,
  verifyPinAttempt,
  loadPinConfig,
  loadPinState,
  isPinConfigured,
  validatePinPolicy,
  isTrivialPin,
  MemoryPinStorage,
  DEFAULT_PIN_ITERATIONS,
  FIRST_LOCKOUT_MS,
  SUBSEQUENT_LOCKOUT_MS,
} from './pin.ts';

test('PIN Política: mínimo 6 dígitos y rechazo de secuencias triviales', () => {
  // Menos de 6 dígitos
  assert.equal(validatePinPolicy('12345').valid, false);
  assert.equal(validatePinPolicy('123').valid, false);

  // Caracteres no numéricos
  assert.equal(validatePinPolicy('12345a').valid, false);
  assert.equal(validatePinPolicy('abcdef').valid, false);

  // Triviales repetidos
  assert.equal(isTrivialPin('111111'), true);
  assert.equal(isTrivialPin('999999'), true);
  assert.equal(validatePinPolicy('111111').valid, false);

  // Triviales consecutivos ascendentes
  assert.equal(isTrivialPin('123456'), true);
  assert.equal(isTrivialPin('234567'), true);
  assert.equal(isTrivialPin('012345'), true);
  assert.equal(validatePinPolicy('123456').valid, false);

  // Triviales consecutivos descendentes
  assert.equal(isTrivialPin('654321'), true);
  assert.equal(isTrivialPin('543210'), true);
  assert.equal(validatePinPolicy('654321').valid, false);

  // Triviales por pares repetidos
  assert.equal(isTrivialPin('121212'), true);
  assert.equal(validatePinPolicy('121212').valid, false);

  // PIN válido no trivial (mínimo 6 dígitos)
  assert.equal(isTrivialPin('839201'), false);
  assert.equal(validatePinPolicy('839201').valid, true);
  assert.equal(validatePinPolicy('491827').valid, true);
});

test('PIN: Obliga a crear el PIN en el primer uso (sin PIN por defecto)', async () => {
  const storage = new MemoryPinStorage();

  // 1. Al inicio no hay ningún PIN configurado
  assert.equal(isPinConfigured(storage), false);
  assert.equal(loadPinConfig(storage), null);

  // Intento de verificación sin PIN configurado
  const attemptWithoutConfig = await verifyPinAttempt('839201', storage);
  assert.equal(attemptWithoutConfig.success, false);
  assert.equal(attemptWithoutConfig.isFirstUseRequired, true);

  // 2. Configurar PIN inicial de 6 dígitos con PBKDF2 (>= 600,000 iteraciones)
  const config = await setupInitialPin('839201', storage, DEFAULT_PIN_ITERATIONS);
  assert.equal(isPinConfigured(storage), true);
  assert.equal(config.iterations >= 600_000, true);
  assert.equal(config.pinHash.length, 64); // SHA-256 hex string

  // El estado de intentos se inicializa en 0
  const state = loadPinState(storage);
  assert.equal(state.failedAttempts, 0);
  assert.equal(state.lockedUntil, null);
  assert.equal(state.lockoutCount, 0);
});

test('PIN: Bloqueo escalado (30 s en 1er bloqueo, 5 min en posteriores) y medición de tiempo PBKDF2', async () => {
  const storage = new MemoryPinStorage();
  const validPin = '839201';
  let virtualTime = 1700000000000;

  await setupInitialPin(validPin, storage, DEFAULT_PIN_ITERATIONS);

  // Medición de tiempo de verificación real
  const measureStart = performance.now();
  const firstSuccess = await verifyPinAttempt(validPin, storage, virtualTime);
  const durationMs = performance.now() - measureStart;

  assert.equal(firstSuccess.success, true);
  assert.ok(durationMs > 0, 'La verificación debe consumir tiempo de CPU');
  console.log(`[BENCHMARK] Tiempo de verificación PBKDF2 (600,000 iteraciones): ${durationMs.toFixed(2)} ms`);
  // Debe ser menor a 1500 ms en entornos normales
  assert.ok(durationMs < 1500, `El tiempo de verificación no debe superar 1.5s (obtenido: ${durationMs} ms)`);

  // Ciclo 1: 3 intentos fallidos provocan el 1er bloqueo de 30 segundos
  await verifyPinAttempt('999888', storage, virtualTime); // Intento 1
  await verifyPinAttempt('999888', storage, virtualTime); // Intento 2
  const lock1 = await verifyPinAttempt('999888', storage, virtualTime); // Intento 3 -> Bloqueo 1

  assert.equal(lock1.isLocked, true);
  assert.equal(lock1.remainingAttempts, 0);
  assert.equal(lock1.lockedRemainingSeconds, 30);
  assert.equal(lock1.nextState.lockoutCount, 1);
  assert.equal(lock1.nextState.lockedUntil, virtualTime + FIRST_LOCKOUT_MS);

  // Intento dentro de la ventana del 1er bloqueo es rechazado
  const duringLock1 = await verifyPinAttempt(validPin, storage, virtualTime + 10_000);
  assert.equal(duringLock1.isLocked, true);
  assert.equal(duringLock1.lockedRemainingSeconds, 20);

  // Avanzamos el tiempo después del 1er bloqueo (+31 segundos)
  virtualTime += 31_000;

  // Ciclo 2: Tras expirar el primer bloqueo, 3 nuevos fallos provocan el 2do bloqueo escalado a 5 minutos (300 s)
  await verifyPinAttempt('999888', storage, virtualTime); // Fallo 1
  await verifyPinAttempt('999888', storage, virtualTime); // Fallo 2
  const lock2 = await verifyPinAttempt('999888', storage, virtualTime); // Fallo 3 -> Bloqueo 2

  assert.equal(lock2.isLocked, true);
  assert.equal(lock2.remainingAttempts, 0);
  assert.equal(lock2.lockedRemainingSeconds, 300); // 5 minutos = 300 s
  assert.equal(lock2.nextState.lockoutCount, 2);
  assert.equal(lock2.nextState.lockedUntil, virtualTime + SUBSEQUENT_LOCKOUT_MS);

  // Avanzamos el tiempo después del 2do bloqueo (+301 segundos)
  virtualTime += 301_000;

  // Un intento correcto posterior desbloquea y reinicia el conteo de bloqueos
  const recovery = await verifyPinAttempt(validPin, storage, virtualTime);
  assert.equal(recovery.success, true);
  assert.equal(recovery.nextState.failedAttempts, 0);
  assert.equal(recovery.nextState.lockoutCount, 0);
  assert.equal(recovery.nextState.lockedUntil, null);
});
