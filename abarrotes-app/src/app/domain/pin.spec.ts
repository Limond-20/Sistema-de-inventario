import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPinConfig,
  createInitialPinState,
  verifyPinAttempt,
  computePinHash,
} from './pin.ts';

test('PIN correcto, incorrecto y bloqueo (3 intentos, 30 s)', async () => {
  const PIN_DEMO = '4321';
  const config = await createPinConfig(PIN_DEMO, 'sal-de-prueba-fija', 3, 30_000);

  // Aseguramos que nunca se guarde el PIN en claro
  assert.equal('pin' in (config as any), false, 'La configuración nunca debe guardar el PIN en texto claro');
  assert.ok(config.pinHash, 'Debe contener un hash SHA-256');
  assert.equal(config.pinHash.length, 64, 'El hash SHA-256 debe tener 64 caracteres hex');

  let state = createInitialPinState();
  const t0 = 100_000;

  // Intento 1 con PIN incorrecto:
  const intento1 = await verifyPinAttempt('0000', config, state, t0);
  assert.equal(intento1.success, false);
  assert.equal(intento1.isLocked, false);
  assert.equal(intento1.remainingAttempts, 2);
  assert.equal(intento1.nextState.failedAttempts, 1);
  state = intento1.nextState;

  // Intento 2 con PIN incorrecto:
  const intento2 = await verifyPinAttempt('1111', config, state, t0 + 1000);
  assert.equal(intento2.success, false);
  assert.equal(intento2.isLocked, false);
  assert.equal(intento2.remainingAttempts, 1);
  assert.equal(intento2.nextState.failedAttempts, 2);
  state = intento2.nextState;

  // Intento 3 con PIN incorrecto (activa bloqueo de 30 segundos):
  const intento3 = await verifyPinAttempt('9999', config, state, t0 + 2000);
  assert.equal(intento3.success, false);
  assert.equal(intento3.isLocked, true, 'Debe quedar bloqueado tras 3 intentos');
  assert.equal(intento3.remainingAttempts, 0);
  assert.equal(intento3.lockedRemainingSeconds, 30);
  assert.equal(intento3.nextState.lockedUntil, (t0 + 2000) + 30_000);
  state = intento3.nextState;

  // Intento 4 durante la ventana de bloqueo (15 segundos después):
  // Incluso con el PIN correcto, debe rechazar por estar bloqueado
  const intentoBloqueado = await verifyPinAttempt(PIN_DEMO, config, state, t0 + 17_000);
  assert.equal(intentoBloqueado.success, false);
  assert.equal(intentoBloqueado.isLocked, true);
  assert.match(intentoBloqueado.message, /bloqueado/i);
  assert.equal(intentoBloqueado.lockedRemainingSeconds, 15);

  // Intento 5 después de transcurridos los 30 segundos de bloqueo (31 segundos después) con PIN correcto:
  const intentoLiberado = await verifyPinAttempt(PIN_DEMO, config, state, t0 + 33_000, 'Don Lupe (Dueño)');
  assert.equal(intentoLiberado.success, true);
  assert.equal(intentoLiberado.isLocked, false);
  assert.equal(intentoLiberado.remainingAttempts, 3);
  assert.equal(intentoLiberado.authorizedBy, 'Don Lupe (Dueño)');
  assert.equal(intentoLiberado.nextState.failedAttempts, 0);
  assert.equal(intentoLiberado.nextState.lockedUntil, null);
});

test('PIN configurable de demostración', async () => {
  // Configuración con PIN personalizado
  const config = await createPinConfig('9876');
  const state = createInitialPinState();

  const fallo = await verifyPinAttempt('1234', config, state);
  assert.equal(fallo.success, false);

  const exito = await verifyPinAttempt('9876', config, state);
  assert.equal(exito.success, true);
});
