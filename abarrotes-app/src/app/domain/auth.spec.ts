import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_PERMISSIONS,
  canAccessRoute,
  checkUserDuplicate,
  createAppUser,
  hasPermission,
  normalizeUserName,
  updateUserPin,
  validateAdminSuicideProtection,
  verifySupervisorPinAttempt,
  verifyUserPinAttempt,
  type AppUser,
} from './auth.ts';

test('Usuarios y Roles (Bloque G): Matriz de permisos estricta por rol', () => {
  // 1. Cajero: únicamente vender, cobrar, abonar
  assert.equal(hasPermission('CAJERO', 'vender'), true);
  assert.equal(hasPermission('CAJERO', 'cobrar'), true);
  assert.equal(hasPermission('CAJERO', 'abonar'), true);
  assert.equal(hasPermission('CAJERO', 'recepcion'), false);
  assert.equal(hasPermission('CAJERO', 'mermas'), false);
  assert.equal(hasPermission('CAJERO', 'auditoria'), false);
  assert.equal(hasPermission('CAJERO', 'cortes'), false);
  assert.equal(hasPermission('CAJERO', 'ajustes'), false);
  assert.equal(hasPermission('CAJERO', 'usuarios'), false);
  assert.equal(hasPermission('CAJERO', 'precios'), false);
  assert.equal(hasPermission('CAJERO', 'respaldos'), false);
  assert.equal(hasPermission('CAJERO', 'restablecer'), false);

  // 2. Encargado: todo lo de Cajero + recepcion, mermas, auditoria, cortes (sin ajustes ni usuarios)
  assert.equal(hasPermission('ENCARGADO', 'vender'), true);
  assert.equal(hasPermission('ENCARGADO', 'cobrar'), true);
  assert.equal(hasPermission('ENCARGADO', 'abonar'), true);
  assert.equal(hasPermission('ENCARGADO', 'recepcion'), true);
  assert.equal(hasPermission('ENCARGADO', 'mermas'), true);
  assert.equal(hasPermission('ENCARGADO', 'auditoria'), true);
  assert.equal(hasPermission('ENCARGADO', 'cortes'), true);
  assert.equal(hasPermission('ENCARGADO', 'ajustes'), false);
  assert.equal(hasPermission('ENCARGADO', 'usuarios'), false);
  assert.equal(hasPermission('ENCARGADO', 'precios'), false);
  assert.equal(hasPermission('ENCARGADO', 'respaldos'), false);
  assert.equal(hasPermission('ENCARGADO', 'restablecer'), false);

  // 3. Administrador: todos los permisos concedidos
  assert.equal(hasPermission('ADMINISTRADOR', 'vender'), true);
  assert.equal(hasPermission('ADMINISTRADOR', 'recepcion'), true);
  assert.equal(hasPermission('ADMINISTRADOR', 'mermas'), true);
  assert.equal(hasPermission('ADMINISTRADOR', 'auditoria'), true);
  assert.equal(hasPermission('ADMINISTRADOR', 'ajustes'), true);
  assert.equal(hasPermission('ADMINISTRADOR', 'usuarios'), true);
  assert.equal(hasPermission('ADMINISTRADOR', 'precios'), true);
  assert.equal(hasPermission('ADMINISTRADOR', 'respaldos'), true);
  assert.equal(hasPermission('ADMINISTRADOR', 'restablecer'), true);

  // 4. Verificación de acceso a rutas
  assert.equal(canAccessRoute('CAJERO', '/pos'), true);
  assert.equal(canAccessRoute('CAJERO', '/recepcion'), false);
  assert.equal(canAccessRoute('CAJERO', '/mermas'), false);
  assert.equal(canAccessRoute('CAJERO', '/ajustes'), false);

  assert.equal(canAccessRoute('ENCARGADO', '/recepcion'), true);
  assert.equal(canAccessRoute('ENCARGADO', '/mermas'), true);
  assert.equal(canAccessRoute('ENCARGADO', '/auditoria'), true);
  assert.equal(canAccessRoute('ENCARGADO', '/ajustes'), false);

  assert.equal(canAccessRoute('ADMINISTRADOR', '/ajustes'), true);
  assert.equal(canAccessRoute('ADMINISTRADOR', '/recepcion'), true);
});

test('Usuarios (Bloque G): Alta de usuario con credenciales PBKDF2 y validación de políticas de PIN', async () => {
  // Rechazo de PIN trivial
  const trivialRes = await createAppUser({
    name: 'Cajero Juan',
    role: 'CAJERO',
    pin: '123456',
    iterations: 1000,
  });
  assert.equal(trivialRes.ok, false);
  assert.match(trivialRes.message, /trivial/i);

  // Rechazo de PIN corto
  const shortRes = await createAppUser({
    name: 'Cajero Juan',
    role: 'CAJERO',
    pin: '9843',
    iterations: 1000,
  });
  assert.equal(shortRes.ok, false);
  assert.match(shortRes.message, /al menos 6 dígitos/i);

  // Aceptación de PIN seguro
  const validRes = await createAppUser({
    name: 'Cajero Juan',
    role: 'CAJERO',
    pin: '984312',
    iterations: 1000,
  });
  assert.equal(validRes.ok, true);
  assert.ok(validRes.user);
  assert.equal(validRes.user.name, 'Cajero Juan');
  assert.equal(validRes.user.role, 'CAJERO');
  assert.equal(validRes.user.isActive, true);
  assert.ok(validRes.user.salt.length >= 32);
  assert.ok(validRes.user.pinHash.length >= 64);
  assert.equal(validRes.user.failedAttempts, 0);
  assert.equal(validRes.user.lockedUntil, null);
});

test('Usuarios (Bloque G): Bloqueo tras intentos fallidos individual por usuario', async () => {
  const user1Res = await createAppUser({
    name: 'Pedro Cajero',
    role: 'CAJERO',
    pin: '839201',
    iterations: 1000,
  });
  const user2Res = await createAppUser({
    name: 'María Encargada',
    role: 'ENCARGADO',
    pin: '719283',
    iterations: 1000,
  });

  let u1 = user1Res.user!;
  let u2 = user2Res.user!;
  const now = Date.now();

  // Intento 1 incorrecto para u1 -> 2 intentos restantes
  const a1 = await verifyUserPinAttempt(u1, '000000', now);
  assert.equal(a1.success, false);
  assert.equal(a1.isLocked, false);
  assert.equal(a1.remainingAttempts, 2);
  u1 = a1.updatedUser;

  // Intento 2 incorrecto para u1 -> 1 intento restante
  const a2 = await verifyUserPinAttempt(u1, '111111', now);
  assert.equal(a2.success, false);
  assert.equal(a2.isLocked, false);
  assert.equal(a2.remainingAttempts, 1);
  u1 = a2.updatedUser;

  // Intento 3 incorrecto para u1 -> BLOQUEADO por 30 segundos
  const a3 = await verifyUserPinAttempt(u1, '222222', now);
  assert.equal(a3.success, false);
  assert.equal(a3.isLocked, true);
  assert.equal(a3.lockedRemainingSeconds, 30);
  assert.match(a3.message, /bloqueado por 30 segundos/i);
  u1 = a3.updatedUser;

  // Si u1 intenta durante el bloqueo, se rechaza inmediatamente
  const lockedAttempt = await verifyUserPinAttempt(u1, '839201', now + 10000);
  assert.equal(lockedAttempt.success, false);
  assert.equal(lockedAttempt.isLocked, true);

  // IMPORTANTE: el bloqueo de u1 NO afecta a u2 (aislamiento estricto por usuario)
  const u2Attempt = await verifyUserPinAttempt(u2, '719283', now);
  assert.equal(u2Attempt.success, true);
  assert.equal(u2Attempt.isLocked, false);

  // Al transcurrir los 30 segundos, u1 puede autenticarse con éxito
  const recoveredAttempt = await verifyUserPinAttempt(u1, '839201', now + 31000);
  assert.equal(recoveredAttempt.success, true);
  assert.equal(recoveredAttempt.isLocked, false);
  assert.equal(recoveredAttempt.updatedUser.failedAttempts, 0);
  assert.equal(recoveredAttempt.updatedUser.lockedUntil, null);
});

test('Usuarios (Bloque G): Cambio de PIN validando PIN actual y políticas de seguridad', async () => {
  const userRes = await createAppUser({
    name: 'Don Lupe Admin',
    role: 'ADMINISTRADOR',
    pin: '839201',
    iterations: 1000,
  });
  let user = userRes.user!;

  // Intento de cambio con PIN actual erróneo
  const wrongCurrent = await updateUserPin(user, '999999', '628491');
  assert.equal(wrongCurrent.success, false);
  assert.match(wrongCurrent.message, /PIN actual incorrecto/i);

  // Intento de cambio con nuevo PIN trivial
  const trivialNew = await updateUserPin(user, '839201', '123456');
  assert.equal(trivialNew.success, false);
  assert.match(trivialNew.message, /secuencia trivial/i);

  // Cambio exitoso
  const successChange = await updateUserPin(user, '839201', '628491');
  assert.equal(successChange.success, true);
  assert.ok(successChange.updatedUser);
  user = successChange.updatedUser;

  // El PIN viejo ya no funciona
  const oldAttempt = await verifyUserPinAttempt(user, '839201');
  assert.equal(oldAttempt.success, false);

  // El PIN nuevo funciona
  const newAttempt = await verifyUserPinAttempt(user, '628491');
  assert.equal(newAttempt.success, true);
});

test('Usuarios (Bloque G): Normalización y prevención de duplicados', () => {
  const users: AppUser[] = [
    {
      id: 'USR-1',
      name: 'María García',
      role: 'CAJERO',
      salt: 'salt1',
      pinHash: 'hash1',
      iterations: 1000,
      isActive: true,
      failedAttempts: 0,
      lockedUntil: null,
      lockoutCount: 0,
      createdAt: '2026-11-10T12:00:00Z',
    },
  ];

  assert.equal(checkUserDuplicate(users, '  maría garcía  '), true);
  assert.equal(checkUserDuplicate(users, 'Maria Garcia'), true); // sin acento
  assert.equal(checkUserDuplicate(users, 'MARIA GARCIA'), true);
  assert.equal(checkUserDuplicate(users, 'María García', 'USR-1'), false); // excluyendo su propio id
  assert.equal(checkUserDuplicate(users, 'Pedro Martínez'), false);
});

test('Protección contra suicidio administrativo (Bloque G seguimiento)', () => {
  const users: AppUser[] = [
    {
      id: 'USR-ADMIN-1',
      name: 'Admin Único',
      role: 'ADMINISTRADOR',
      salt: 'salt1',
      pinHash: 'hash1',
      iterations: 1000,
      isActive: true,
      failedAttempts: 0,
      lockedUntil: null,
      lockoutCount: 0,
      createdAt: '2026-11-10T12:00:00Z',
    },
    {
      id: 'USR-CAJERO-1',
      name: 'Cajero 1',
      role: 'CAJERO',
      salt: 'salt2',
      pinHash: 'hash2',
      iterations: 1000,
      isActive: true,
      failedAttempts: 0,
      lockedUntil: null,
      lockoutCount: 0,
      createdAt: '2026-11-10T12:00:00Z',
    },
  ];

  // 1. Desactivar al único admin activo -> RECHAZADO
  const deactRes = validateAdminSuicideProtection(users, 'USR-ADMIN-1', 'DEACTIVATE');
  assert.equal(deactRes.allowed, false);
  assert.match(deactRes.error || '', /No es posible desactivar al único Administrador activo/i);

  // 2. Eliminar al único admin activo -> RECHAZADO
  const delRes = validateAdminSuicideProtection(users, 'USR-ADMIN-1', 'DELETE');
  assert.equal(delRes.allowed, false);
  assert.match(delRes.error || '', /No es posible eliminar al único Administrador activo/i);

  // 3. Degradar rol de único admin activo (a ENCARGADO o CAJERO) -> RECHAZADO
  const roleDegradeRes = validateAdminSuicideProtection(users, 'USR-ADMIN-1', 'CHANGE_ROLE', 'ENCARGADO');
  assert.equal(roleDegradeRes.allowed, false);
  assert.match(roleDegradeRes.error || '', /No es posible degradar el rol del único Administrador activo/i);

  const roleDegradeCajero = validateAdminSuicideProtection(users, 'USR-ADMIN-1', 'CHANGE_ROLE', 'CAJERO');
  assert.equal(roleDegradeCajero.allowed, false);

  // Mantener rol ADMINISTRADOR -> PERMITIDO
  const keepAdmin = validateAdminSuicideProtection(users, 'USR-ADMIN-1', 'CHANGE_ROLE', 'ADMINISTRADOR');
  assert.equal(keepAdmin.allowed, true);

  // Desactivar a un cajero -> PERMITIDO
  const deactCajero = validateAdminSuicideProtection(users, 'USR-CAJERO-1', 'DEACTIVATE');
  assert.equal(deactCajero.allowed, true);

  // 4. Si existe un segundo admin activo, sí se permite desactivar o degradar al primero
  const twoAdminsUsers: AppUser[] = [
    ...users,
    {
      id: 'USR-ADMIN-2',
      name: 'Admin Segundo',
      role: 'ADMINISTRADOR',
      salt: 'salt3',
      pinHash: 'hash3',
      iterations: 1000,
      isActive: true,
      failedAttempts: 0,
      lockedUntil: null,
      lockoutCount: 0,
      createdAt: '2026-11-10T12:00:00Z',
    },
  ];

  const allowedDeact = validateAdminSuicideProtection(twoAdminsUsers, 'USR-ADMIN-1', 'DEACTIVATE');
  assert.equal(allowedDeact.allowed, true);

  const allowedDegrade = validateAdminSuicideProtection(twoAdminsUsers, 'USR-ADMIN-1', 'CHANGE_ROLE', 'ENCARGADO');
  assert.equal(allowedDegrade.allowed, true);
});

test('Elevación puntual de privilegios con PIN de supervisor (Bloque G seguimiento)', async () => {
  const adminRes = await createAppUser({
    name: 'Admin Supervisor',
    role: 'ADMINISTRADOR',
    pin: '984312',
    iterations: 1000,
  });
  const encRes = await createAppUser({
    name: 'Encargado Pasillo',
    role: 'ENCARGADO',
    pin: '839201',
    iterations: 1000,
  });
  const cajeroRes = await createAppUser({
    name: 'Cajero Operador',
    role: 'CAJERO',
    pin: '719283',
    iterations: 1000,
  });

  const users: AppUser[] = [adminRes.user!, encRes.user!, cajeroRes.user!];

  // 1. PIN de cajero como supervisor -> RECHAZADO (un cajero no puede autorizar su propio descuento o override)
  const cajeroAttempt = await verifySupervisorPinAttempt(users, '719283');
  assert.equal(cajeroAttempt.success, false);
  assert.match(cajeroAttempt.message, /PIN de supervisor incorrecto o no autorizado/i);

  // 2. PIN de Encargado -> ACEPTADO
  const encAttempt = await verifySupervisorPinAttempt(users, '839201');
  assert.equal(encAttempt.success, true);
  assert.equal(encAttempt.supervisor?.name, 'Encargado Pasillo');
  assert.equal(encAttempt.supervisor?.role, 'ENCARGADO');

  // 3. PIN de Administrador -> ACEPTADO
  const adminAttempt = await verifySupervisorPinAttempt(users, '984312');
  assert.equal(adminAttempt.success, true);
  assert.equal(adminAttempt.supervisor?.name, 'Admin Supervisor');
  assert.equal(adminAttempt.supervisor?.role, 'ADMINISTRADOR');

  // 4. PIN incorrecto -> RECHAZADO
  const wrongAttempt = await verifySupervisorPinAttempt(users, '000000');
  assert.equal(wrongAttempt.success, false);
});
