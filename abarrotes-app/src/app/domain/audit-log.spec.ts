import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GENESIS_SECURITY_AUDIT_HASH,
  createSecurityAuditEntry,
  verifySecurityAuditChain,
  type SecurityAuditEntry,
} from './audit-log.ts';

test('Bitácora de Auditoría (Bloque G): Encadenamiento criptográfico SHA-256 inmutable', () => {
  // 1. Cadena vacía es válida
  assert.equal(verifySecurityAuditChain([]).valid, true);

  // 2. Primera entrada (Génesis)
  const e1 = createSecurityAuditEntry({
    action: 'SETTINGS_UPDATED',
    actorUser: 'Don Lupe (Admin)',
    details: 'Nombre del negocio configurado a "Abarrotes El Triunfo"',
    metadata: { previousName: 'Mi Tiendita', newName: 'Abarrotes El Triunfo' },
  });

  assert.equal(e1.sequence, 1);
  assert.equal(e1.prevHash, GENESIS_SECURITY_AUDIT_HASH);
  assert.ok(e1.entryHash.length === 64);

  // 3. Segunda entrada encadenada a e1
  const e2 = createSecurityAuditEntry(
    {
      action: 'USER_CREATED',
      actorUser: 'Don Lupe (Admin)',
      targetUser: 'Juan Pérez',
      details: 'Alta de usuario Juan Pérez con rol CAJERO',
      metadata: { role: 'CAJERO' },
    },
    e1
  );

  assert.equal(e2.sequence, 2);
  assert.equal(e2.prevHash, e1.entryHash);
  assert.ok(e2.entryHash.length === 64);

  // 4. Tercera entrada encadenada a e2
  const e3 = createSecurityAuditEntry(
    {
      action: 'PIN_CHANGED',
      actorUser: 'Juan Pérez',
      targetUser: 'Juan Pérez',
      details: 'El usuario actualizó su PIN de acceso de 6 dígitos',
    },
    e2
  );

  assert.equal(e3.sequence, 3);
  assert.equal(e3.prevHash, e2.entryHash);

  // 5. Verificación de la cadena en orden newest-first (como se almacena en la app)
  const newestFirstList = [e3, e2, e1];
  const validCheckNewest = verifySecurityAuditChain(newestFirstList, 'newest-first');
  assert.equal(validCheckNewest.valid, true);

  // 6. Verificación de la cadena en orden oldest-first
  const oldestFirstList = [e1, e2, e3];
  const validCheckOldest = verifySecurityAuditChain(oldestFirstList, 'oldest-first');
  assert.equal(validCheckOldest.valid, true);
});

test('Bitácora de Auditoría (Bloque G): Detección inmediata de alteración maliciosa en campos o hashes', () => {
  const e1 = createSecurityAuditEntry({
    action: 'SETTINGS_UPDATED',
    actorUser: 'Admin',
    details: 'Fondo inicial establecido en $1,000.00',
  });
  const e2 = createSecurityAuditEntry(
    {
      action: 'USER_CREATED',
      actorUser: 'Admin',
      targetUser: 'Cajera Rosa',
      details: 'Alta de usuaria Rosa',
    },
    e1
  );
  const e3 = createSecurityAuditEntry(
    {
      action: 'PIN_CHANGED',
      actorUser: 'Admin',
      details: 'Cambio de PIN de administrador',
    },
    e2
  );

  // Caso A: Manipulación del texto de detalles en e2
  const tamperedDetailsList: SecurityAuditEntry[] = [
    { ...e3 },
    { ...e2, details: 'Detalle alterado maliciosamente por un intruso' },
    { ...e1 },
  ];
  const checkA = verifySecurityAuditChain(tamperedDetailsList, 'newest-first');
  assert.equal(checkA.valid, false);
  assert.match(checkA.error!, /Hash alterado en secuencia #2/);
  assert.equal(checkA.corruptedIndex, 1);

  // Caso B: Manipulación del prevHash en e3
  const tamperedPrevHashList: SecurityAuditEntry[] = [
    { ...e3, prevHash: '1111111111111111111111111111111111111111111111111111111111111111' },
    { ...e2 },
    { ...e1 },
  ];
  const checkB = verifySecurityAuditChain(tamperedPrevHashList, 'newest-first');
  assert.equal(checkB.valid, false);
  assert.match(checkB.error!, /Ruptura en la cadena en secuencia #3/);
  assert.equal(checkB.corruptedIndex, 0);
});
