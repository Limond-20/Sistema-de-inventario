/**
 * Bloque K: pruebas de integración en navegador real (Karma + ChromeHeadless + IndexedDB real).
 * Las pruebas de dominio puras están en src/app/domain/encrypted-storage.spec.ts y privacy.spec.ts.
 */
import { MockInventoryService } from './mock-inventory.service';
import {
  IndexedDbStateStorageAdapter,
  MemoryStateStorageAdapter,
  STATE_STORAGE_KEY,
  CORRUPT_STATE_KEY_PREFIX,
  type StateStorageAdapter,
} from '../domain/persistence';
import {
  EncryptedStorageAdapter,
  STORAGE_KEYSTORE_KEY,
  isEncryptedEnvelope,
} from '../domain/encrypted-storage';
import { InMemoryEncryptedBackupAdapter, encryptBackupBytes } from '../domain/backup';
import { verifyKardexChain } from '../domain/kardex';

const TEST_DB = 'binnitech_test_bloque_k';
const NEW_ADMIN_PIN = '847261';
const OTHER_PIN = '615243';
const DEMO_ADMIN_PIN = '984312'; // auth.ts: usuario demo "Administrador"
const DEMO_ENCARGADO_PIN = '839201'; // auth.ts: usuario demo "Don Lupe (Encargado)"
const CUSTOMER_NAME = 'Doña Eufrosina Matus Regalado';
const CUSTOMER_PHONE = '971-555-0199';
const SLOW = 90_000; // PBKDF2 con 600,000 iteraciones real en cada desbloqueo

function rawIdb(): IndexedDbStateStorageAdapter {
  return new IndexedDbStateStorageAdapter(TEST_DB, 'app_state');
}

function newEncryptedAdapter(): EncryptedStorageAdapter {
  return new EncryptedStorageAdapter(rawIdb());
}

async function openService(adapter: StateStorageAdapter): Promise<MockInventoryService> {
  const svc = new MockInventoryService();
  svc.storageAdapter = adapter;
  svc.backupAdapter = new InMemoryEncryptedBackupAdapter(30, 2_000);
  await svc.acquireWriterLock();
  return svc;
}

async function closeService(svc: MockInventoryService): Promise<void> {
  await svc.releaseWriterLock();
  svc.ngOnDestroy();
}

function cartFor(svc: MockInventoryService, sku = 'LAC-LAL-1L', qty = 1): any[] {
  const p = svc.products().find((x) => x.sku === sku)!;
  return [
    {
      sku: p.sku,
      barcode: p.barcode,
      name: p.name,
      emoji: p.emoji,
      saleUnit: p.saleUnit,
      isBulk: false,
      qty,
      unitPrice: p.salePrice,
      subtotal: qty * p.salePrice,
    },
  ];
}

async function createConsentedCustomer(svc: MockInventoryService) {
  await svc.ensurePrivacyNoticeInitialized();
  const res = svc.createCustomer(
    { name: CUSTOMER_NAME, phone: CUSTOMER_PHONE, alias: 'La del molino', creditLimit: 900, creditDays: 15, notes: 'Junto al molino de nixtamal' },
    true,
    { accepted: true, method: 'PRESENCIAL_VERBAL' }
  );
  expect(res.ok).withContext(res.message).toBeTrue();
  return res.customer!;
}

async function dumpRaw(): Promise<string> {
  const raw = rawIdb();
  const keys = await raw.listKeys();
  return JSON.stringify(await Promise.all(keys.map((k) => raw.load(k))));
}

describe('Bloque K: cifrado en reposo y datos personales (integración)', () => {
  beforeEach(async () => {
    localStorage.clear();
    await rawIdb().clear();
  });

  afterEach(async () => {
    await rawIdb().clear();
    localStorage.clear();
  });

  it('K-I1. Instalación nueva: se crea el PIN, se cifra y el dato en IndexedDB no es legible', async () => {
    const svc = await openService(newEncryptedAdapter());
    const first = await svc.restorePersistedState();
    expect(first.locked).toBeTrue();
    expect(svc.storageCryptoStatus()).toBe('setup-new');
    expect(svc.isHydrated()).toBeFalse();

    expect((await svc.setupEncryptedStorage('123456', '123456')).ok).toBeFalse(); // PIN trivial
    expect((await svc.setupEncryptedStorage(NEW_ADMIN_PIN, '847262')).ok).toBeFalse(); // no coinciden
    const setup = await svc.setupEncryptedStorage(NEW_ADMIN_PIN, NEW_ADMIN_PIN);
    expect(setup.ok).withContext(setup.message).toBeTrue();
    expect(svc.isHydrated()).toBeTrue();
    expect(svc.storageCryptoStatus()).toBe('unlocked');
    expect(svc.securityAuditLog()[0].action).toBe('STORAGE_ENCRYPTION_CONFIGURED');

    const customer = await createConsentedCustomer(svc);
    expect(svc.processCreditSale(cartFor(svc), customer.id).ok).toBeTrue();
    await svc.flushSave();
    expect(svc.lastSaveError()).toBeNull();

    const keys = await rawIdb().listKeys();
    expect(keys).toContain(STATE_STORAGE_KEY);
    expect(keys).toContain(STORAGE_KEYSTORE_KEY);
    expect(isEncryptedEnvelope(await rawIdb().load(STATE_STORAGE_KEY))).toBeTrue();
    const dump = await dumpRaw();
    for (const secret of ['Eufrosina', CUSTOMER_PHONE, 'Leche', 'creditCustomers', 'Doña Carmen', NEW_ADMIN_PIN]) {
      expect(dump.includes(secret)).withContext(`"${secret}" no debe ser legible en IndexedDB`).toBeFalse();
    }
    await closeService(svc);
  }, SLOW);

  it('K-I2. Al reiniciar, el PIN incorrecto no abre los datos y el correcto los carga completos', async () => {
    const svc = await openService(newEncryptedAdapter());
    await svc.restorePersistedState();
    await svc.setupEncryptedStorage(NEW_ADMIN_PIN, NEW_ADMIN_PIN);
    const customer = await createConsentedCustomer(svc);
    svc.processCreditSale(cartFor(svc), customer.id);
    await svc.flushSave();
    const expectedBalance = svc.getCustomerDetail(customer.id)!.currentBalance;
    await closeService(svc);

    const reopened = await openService(newEncryptedAdapter());
    const res = await reopened.restorePersistedState();
    expect(res.locked).toBeTrue();
    expect(reopened.storageCryptoStatus()).toBe('locked');
    expect(reopened.isHydrated()).toBeFalse();
    expect(reopened.getCustomerDetail(customer.id)).toBeUndefined();

    const wrong = await reopened.unlockEncryptedStorage('502938');
    expect(wrong.ok).toBeFalse();
    expect(wrong.message).toContain('incorrecto');
    expect(wrong.message).toContain('Intentos restantes: 4');
    expect(reopened.isHydrated()).toBeFalse();

    const right = await reopened.unlockEncryptedStorage(NEW_ADMIN_PIN);
    expect(right.ok).withContext(right.message).toBeTrue();
    expect(reopened.isHydrated()).toBeTrue();
    expect(reopened.getCustomerDetail(customer.id)!.currentBalance).toBe(expectedBalance);
    expect(reopened.verifyKardexIntegrity().valid).toBeTrue();
    await closeService(reopened);
  }, SLOW);

  it('K-I3. Migración: el estado sin cifrar existente se cifra con el PIN actual del administrador', async () => {
    // Estado guardado por una versión anterior (sin Bloque K) directamente en IndexedDB.
    const plain = await openService(new MemoryStateStorageAdapter());
    await plain.restorePersistedState();
    const customer = await createConsentedCustomer(plain);
    plain.processCreditSale(cartFor(plain), customer.id);
    const legacySnapshot = structuredClone(plain.getPersistedStateSnapshot());
    await closeService(plain);
    const corruptKey = `${CORRUPT_STATE_KEY_PREFIX}2026-11-01T00:00:00.000Z`;
    await rawIdb().save(STATE_STORAGE_KEY, legacySnapshot);
    await rawIdb().save(corruptKey, { schemaVersion: 6, nota: CUSTOMER_NAME });
    expect((await dumpRaw()).includes('Eufrosina')).toBeTrue();

    const svc = await openService(newEncryptedAdapter());
    const gate = await svc.restorePersistedState();
    expect(gate.locked).toBeTrue();
    expect(svc.storageCryptoStatus()).toBe('setup-migrate');

    const notAdmin = await svc.setupEncryptedStorage(DEMO_ENCARGADO_PIN);
    expect(notAdmin.ok).toBeFalse();
    expect(svc.isHydrated()).toBeFalse();

    const migrated = await svc.setupEncryptedStorage(DEMO_ADMIN_PIN);
    expect(migrated.ok).withContext(migrated.message).toBeTrue();
    expect(migrated.message).toContain('2 registro(s)');
    expect(svc.isHydrated()).toBeTrue();
    expect(svc.getCustomerDetail(customer.id)!.name).toBe(CUSTOMER_NAME);
    expect(svc.verifyKardexIntegrity().valid).toBeTrue();

    expect(isEncryptedEnvelope(await rawIdb().load(STATE_STORAGE_KEY))).toBeTrue();
    expect(isEncryptedEnvelope(await rawIdb().load(corruptKey))).toBeTrue();
    expect((await dumpRaw()).includes('Eufrosina')).toBeFalse();
    await closeService(svc);
  }, SLOW);

  it('K-I4. Cambiar el PIN del administrador re-envuelve la llave: el PIN viejo ya no abre', async () => {
    const svc = await openService(newEncryptedAdapter());
    await svc.restorePersistedState();
    await svc.setupEncryptedStorage(NEW_ADMIN_PIN, NEW_ADMIN_PIN);
    const change = await svc.changeUserPin('USR-ADMIN', NEW_ADMIN_PIN, OTHER_PIN);
    expect(change.ok).withContext(change.message).toBeTrue();
    expect(change.message).toBe('PIN actualizado correctamente.');
    await closeService(svc);

    const reopened = await openService(newEncryptedAdapter());
    await reopened.restorePersistedState();
    expect((await reopened.unlockEncryptedStorage(NEW_ADMIN_PIN)).ok).toBeFalse();
    expect((await reopened.unlockEncryptedStorage(OTHER_PIN)).ok).toBeTrue();
    expect(reopened.isHydrated()).toBeTrue();
    await closeService(reopened);
  }, SLOW);

  it('K-I5. PIN olvidado: se recupera desde un respaldo .bak (frase de respaldo) y se define un PIN nuevo', async () => {
    const svc = await openService(newEncryptedAdapter());
    await svc.restorePersistedState();
    await svc.setupEncryptedStorage(NEW_ADMIN_PIN, NEW_ADMIN_PIN);
    const customer = await createConsentedCustomer(svc);
    await svc.flushSave();
    const bak = await encryptBackupBytes(
      new TextEncoder().encode(JSON.stringify(svc.getPersistedStateSnapshot())),
      'frase-de-respaldo-k',
      2_000
    );
    await closeService(svc);

    const locked = await openService(newEncryptedAdapter());
    await locked.restorePersistedState();
    expect(locked.storageCryptoStatus()).toBe('locked');

    const badPhrase = await locked.beginEncryptedStorageRecovery({ passphrase: 'frase-equivocada', bakBytes: bak });
    expect(badPhrase.ok).toBeFalse();
    const verified = await locked.beginEncryptedStorageRecovery({ passphrase: 'frase-de-respaldo-k', bakBytes: bak });
    expect(verified.ok).withContext(verified.message).toBeTrue();
    expect(verified.admins!.map((a) => a.id)).toContain('USR-ADMIN');
    expect(locked.isHydrated()).toBeFalse();

    expect((await locked.completeEncryptedStorageRecovery('USR-ADMIN', OTHER_PIN, '000111')).ok).toBeFalse();
    const done = await locked.completeEncryptedStorageRecovery('USR-ADMIN', OTHER_PIN, OTHER_PIN);
    expect(done.ok).withContext(done.message).toBeTrue();
    expect(locked.isHydrated()).toBeTrue();
    expect(locked.getCustomerDetail(customer.id)!.name).toBe(CUSTOMER_NAME);
    expect(locked.securityAuditLog()[0].action).toBe('STORAGE_RECOVERED_FROM_BACKUP');
    expect((await dumpRaw()).includes('Eufrosina')).toBeFalse();
    await closeService(locked);

    const reopened = await openService(newEncryptedAdapter());
    await reopened.restorePersistedState();
    expect((await reopened.unlockEncryptedStorage(NEW_ADMIN_PIN)).ok).toBeFalse();
    expect((await reopened.unlockEncryptedStorage(OTHER_PIN)).ok).toBeTrue();
    expect(reopened.getCustomerDetail(customer.id)).toBeTruthy();
    // El PIN nuevo también sirve para iniciar sesión como administrador.
    expect((await reopened.loginWithPin('USR-ADMIN', OTHER_PIN)).success).toBeTrue();
    await closeService(reopened);
  }, SLOW);

  it('K-I6. Consentimiento, exportación y anonimización sin romper el Kardex ni el saldo', async () => {
    const svc = await openService(new MemoryStateStorageAdapter());
    await svc.restorePersistedState();
    await svc.ensurePrivacyNoticeInitialized();

    const noConsent = svc.createCustomer({ name: CUSTOMER_NAME, creditLimit: 900 }, true, { accepted: false });
    expect(noConsent.ok).toBeFalse();

    const customer = await createConsentedCustomer(svc);
    const consent = customer.privacy!.consents[0];
    expect(consent.noticeVersion).toBe(1);
    expect(consent.collectedBy).toBe(svc.activeUser());
    expect(consent.noticeTextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(svc.getCustomerConsentStatus(customer)).toBe('VIGENTE');

    expect(svc.processCreditSale(cartFor(svc, 'LAC-LAL-1L', 3), customer.id).ok).toBeTrue();
    expect(svc.registerCreditPayment(customer.id, 20).ok).toBeTrue();
    const kardexBefore = svc.kardex();
    const balanceBefore = svc.getCustomerDetail(customer.id)!.currentBalance;
    expect(balanceBefore).toBeGreaterThan(0);

    // Los movimientos nuevos del Kardex solo guardan el ID del cliente.
    const linked = kardexBefore.filter((k) => k.customerId === customer.id);
    expect(linked.map((k) => k.type).sort()).toEqual(['ABONO_FIADO', 'VENTA_FIADO']);
    expect(JSON.stringify(kardexBefore).includes('Eufrosina')).toBeFalse();
    expect(svc.kardexDisplayText(linked[0])).toContain(CUSTOMER_NAME);

    // Acceso: exportación con PIN de encargado.
    expect((await svc.exportCustomerPersonalData(customer.id, '000000')).ok).toBeFalse();
    const exported = await svc.exportCustomerPersonalData(customer.id, DEMO_ENCARGADO_PIN);
    expect(exported.ok).withContext(exported.message).toBeTrue();
    const data = JSON.parse(exported.json!);
    expect(data.titular.nombre).toBe(CUSTOMER_NAME);
    expect(data.titular.telefono).toBe(CUSTOMER_PHONE);
    expect(data.credito.saldoActual).toBe(balanceBefore);
    expect(data.kardexRelacionado.movimientos.length).toBe(2);
    expect(data.privacidad.consentimientos[0].textoDelAviso).toContain('AVISO DE PRIVACIDAD');
    expect(exported.fileName).toMatch(/^datos-cliente-/);

    // Cancelación: solo el administrador puede anonimizar.
    expect((await svc.anonymizeCustomer(customer.id, DEMO_ENCARGADO_PIN)).ok).toBeFalse();
    const anon = await svc.anonymizeCustomer(customer.id, DEMO_ADMIN_PIN);
    expect(anon.ok).withContext(anon.message).toBeTrue();
    expect(anon.report!.kardexModified).toBeFalse();
    expect(anon.report!.kardexEntriesRetained).toBe(2);

    const after = svc.getCustomerDetail(customer.id)!;
    expect(after.name).toBe(`Cliente anonimizado ${customer.id}`);
    expect(after.phone).toBe('');
    expect(after.currentBalance).toBe(balanceBefore);
    expect(svc.kardex()).toBe(kardexBefore);
    expect(svc.verifyKardexIntegrity().valid).toBeTrue();
    expect(svc.getCustomerConsentStatus(after)).toBe('ANONIMIZADO');

    const snapshotJson = JSON.stringify(svc.getPersistedStateSnapshot());
    for (const secret of ['Eufrosina', CUSTOMER_PHONE, 'La del molino', 'molino de nixtamal']) {
      expect(snapshotJson.includes(secret)).withContext(`"${secret}" debe desaparecer`).toBeFalse();
    }
    expect(svc.kardexDisplayText(linked[0])).toContain('datos personales ocultos');

    // Ya no admite fiado nuevo, pero sí abonos para liquidar su saldo.
    expect(svc.processCreditSale(cartFor(svc), customer.id).ok).toBeFalse();
    expect(svc.registerCreditPayment(customer.id, 10).ok).toBeTrue();
    expect(svc.getCustomerDetail(customer.id)!.currentBalance).toBeCloseTo(balanceBefore - 10, 2);
    await closeService(svc);
  }, SLOW);

  it('K-I7. Aviso configurable: solo el administrador publica; la versión nueva pide renovar el consentimiento', async () => {
    const shared = new MemoryStateStorageAdapter();
    const svc = await openService(shared);
    await svc.restorePersistedState();
    const customer = await createConsentedCustomer(svc);
    const input = {
      template: svc.privacyNotice()!.template,
      responsibleName: 'Guadalupe Martínez',
      contact: 'WhatsApp 971-000-0000',
    };

    expect(svc.currentUser()!.role).toBe('ENCARGADO');
    expect((await svc.publishPrivacyNotice(input)).ok).toBeFalse();

    expect((await svc.loginWithPin('USR-ADMIN', DEMO_ADMIN_PIN)).success).toBeTrue();
    const published = await svc.publishPrivacyNotice(input);
    expect(published.ok).withContext(published.message).toBeTrue();
    expect(svc.privacyNotice()!.currentVersion).toBe(2);
    expect(svc.currentPrivacyNoticeVersion()!.text).toContain('Guadalupe Martínez');
    expect(svc.getCustomerConsentStatus(svc.getCustomerDetail(customer.id))).toBe('VERSION_ANTERIOR');
    expect(svc.customersPendingConsent().some((c) => c.id === customer.id)).toBeTrue();

    expect((await svc.recordCustomerConsent(customer.id, { method: 'FIRMA_EN_PAPEL' })).ok).toBeTrue();
    expect(svc.getCustomerConsentStatus(svc.getCustomerDetail(customer.id))).toBe('VIGENTE');
    expect(svc.getCustomerDetail(customer.id)!.privacy!.consents.length).toBe(2);
    await svc.flushSave();
    await closeService(svc);

    const reloaded = await openService(shared);
    await reloaded.restorePersistedState();
    expect(reloaded.privacyNotice()!.versions.length).toBe(2);
    expect(reloaded.getCustomerConsentStatus(reloaded.getCustomerDetail(customer.id))).toBe('VIGENTE');
    expect(verifyKardexChain(reloaded.kardex(), 'newest-first').valid).toBeTrue();
    await closeService(reloaded);
  }, SLOW);
});
