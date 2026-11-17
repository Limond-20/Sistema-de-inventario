import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRIVACY_NOTICE_TEMPLATE,
  buildDefaultPrivacyNoticeConfig,
  publishPrivacyNoticeVersion,
  getCurrentNoticeVersion,
  createConsentRecord,
  appendConsentToCustomer,
  getConsentStatus,
  computeTextHash,
  buildCustomerDataExport,
  anonymizeCustomerData,
  registerOpposition,
  findKardexEntriesForCustomer,
  isCustomerAnonymized,
  buildAnonymizedName,
} from './privacy.ts';
import { createKardexEntry, verifyKardexChain, verifyProductContinuity, type KardexEntry } from './kardex.ts';

const NOW = new Date(2026, 10, 16, 21, 30, 0);

function buildKardex(): KardexEntry[] {
  // Movimiento histórico (antes del Bloque K) que todavía trae el nombre del cliente.
  const e1 = createKardexEntry(
    {
      type: 'VENTA_FIADO',
      producto: { sku: 'LAC-LAL-1L', name: 'Leche Lala 1L' },
      cantidad: -2,
      saldoAnterior: 12,
      saldoResultante: 10,
      usuario: 'Don Lupe (Encargado)',
      referencia: 'Fiado Cliente Doña Eufrosina Matus',
      description: 'Fiado a Doña Eufrosina Matus: 2 Pieza de Leche Lala 1L',
      amount: 52,
    },
    'GENESIS'
  );
  // Movimiento nuevo (Bloque K): solo el ID del cliente.
  const e2 = {
    ...createKardexEntry(
      {
        type: 'ABONO_FIADO',
        producto: { sku: 'CLI-77', name: 'Cliente CLI-77' },
        cantidad: 0,
        saldoAnterior: 297.5,
        saldoResultante: 245.5,
        usuario: 'María (Cajera Mañana)',
        referencia: 'Abono deudor (EFECTIVO): CLI-77',
        description: 'Abono en efectivo recibido del cliente CLI-77',
        amount: 52,
      },
      e1.entryHash
    ),
    customerId: 'CLI-77',
  };
  const other = createKardexEntry(
    {
      type: 'VENTA',
      producto: { sku: 'LAC-LAL-1L', name: 'Leche Lala 1L' },
      cantidad: -1,
      saldoAnterior: 10,
      saldoResultante: 9,
      usuario: 'María (Cajera Mañana)',
      referencia: 'Venta mostrador',
      amount: 26,
    },
    e2.entryHash
  );
  return [other, e2, e1]; // newest-first
}

function buildScope() {
  const customer = {
    id: 'CLI-77',
    name: 'Doña Eufrosina Matus',
    alias: 'La del molino',
    phone: '971-555-0199',
    notes: 'Vive junto al molino de nixtamal, paga los viernes.',
    creditLimit: 800,
    creditDays: 15,
    currentBalance: 245.5,
    creditFavorBalance: 0,
    status: 'AL_CORRIENTE',
    isActive: true,
    debts: [
      { id: 'D1', date: '2026-11-10', dueDate: '2026-11-25', originalAmount: 297.5, remainingBalance: 245.5, description: 'Fiado POS #V-0003' },
    ],
    payments: [
      { id: 'P1', date: '2026-11-12T10:00:00', amount: 52, previousBalance: 297.5, remainingBalance: 245.5, note: 'Abono deudor: Doña Eufrosina Matus' },
    ],
  };
  const otherCustomer = {
    id: 'CLI-01',
    name: 'Taller Mecánico El Istmo',
    phone: '971-111-2222',
    creditLimit: 600,
    currentBalance: 100,
    debts: [],
    payments: [],
  };
  return {
    creditCustomers: [customer, otherCustomer],
    salesHistory: [
      { folio: 'V-0003', date: '2026-11-10', customerId: 'CLI-77', customerName: 'Doña Eufrosina Matus', total: 297.5, items: [{ name: 'Maseca 1kg', qty: 5, subtotal: 297.5 }], status: 'COMPLETADA' },
      { folio: 'V-0004', date: '2026-11-11', customerId: 'CLI-01', customerName: 'Taller Mecánico El Istmo', total: 100, items: [] },
    ],
    saleReturns: [],
    cashMovements: [
      { id: 'CM1', type: 'ENTRADA', amount: 52, date: '2026-11-12', reason: 'Abono de cliente: Doña Eufrosina Matus', notes: 'Abono a crédito recibido en efectivo de Doña Eufrosina Matus: $52.00', reference: 'ABONO-CLI-77-1731400000000' },
      { id: 'CM2', type: 'SALIDA', amount: 30, date: '2026-11-12', reason: 'Pago de garrafón', reference: 'GASTO-1' },
    ],
    kardex: buildKardex(),
    morningAlerts: [
      { id: 'A1', title: 'Cobrar a Doña Eufrosina Matus', detail: 'Vence el 25/11' },
      { id: 'A2', title: 'Stock bajo de Maseca', detail: '' },
    ],
  };
}

test('K11: aviso de privacidad configurable y versionado con huella SHA-256', async () => {
  const config = await buildDefaultPrivacyNoticeConfig('Abarrotes La Esperanza', NOW);
  assert.equal(config.currentVersion, 1);
  const v1 = getCurrentNoticeVersion(config)!;
  assert.match(v1.text, /Abarrotes La Esperanza/);
  assert.equal(v1.textHash, await computeTextHash(v1.text));

  const invalid = await publishPrivacyNoticeVersion(config, {
    template: 'muy corto',
    responsibleName: '',
    contact: '',
    storeName: 'Abarrotes La Esperanza',
    publishedBy: 'Administrador',
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors?.length, 3);

  const published = await publishPrivacyNoticeVersion(
    config,
    {
      template: DEFAULT_PRIVACY_NOTICE_TEMPLATE,
      responsibleName: 'Guadalupe Martínez',
      contact: 'WhatsApp 971-000-0000',
      storeName: 'Abarrotes La Esperanza',
      publishedBy: 'Administrador',
    },
    NOW
  );
  assert.equal(published.ok, true);
  assert.equal(published.config.currentVersion, 2);
  assert.equal(published.config.versions.length, 2, 'las versiones anteriores se conservan');
  const v2 = getCurrentNoticeVersion(published.config)!;
  assert.match(v2.text, /Guadalupe Martínez/);
  assert.match(v2.text, /WhatsApp 971-000-0000/);
  assert.ok(!v2.text.includes('{{'), 'no deben quedar marcadores sin reemplazar');

  const again = await publishPrivacyNoticeVersion(published.config, {
    template: DEFAULT_PRIVACY_NOTICE_TEMPLATE,
    responsibleName: 'Guadalupe Martínez',
    contact: 'WhatsApp 971-000-0000',
    storeName: 'Abarrotes La Esperanza',
    publishedBy: 'Administrador',
  });
  assert.equal(again.config.currentVersion, 2, 'mismo texto -> no se crea versión nueva');
});

test('K12: registro de consentimiento por cliente (fecha, versión del texto y quién lo recabó)', async () => {
  const config = await buildDefaultPrivacyNoticeConfig('Abarrotes La Esperanza', NOW);
  const notice = getCurrentNoticeVersion(config)!;
  const customer = buildScope().creditCustomers[0];
  assert.equal(getConsentStatus(customer, config), 'SIN_CONSENTIMIENTO');

  assert.throws(() => createConsentRecord({ notice, collectedBy: '  ' }), /quién recabó/);
  const consent = createConsentRecord({
    notice,
    collectedBy: 'María (Cajera Mañana)',
    collectedByUserId: 'USR-MARIA',
    method: 'PRESENCIAL_VERBAL',
    now: NOW,
  });
  assert.equal(consent.noticeVersion, 1);
  assert.equal(consent.noticeTextHash, notice.textHash);
  assert.equal(consent.collectedBy, 'María (Cajera Mañana)');
  assert.equal(consent.acceptedLocalDate, '2026-11-16');
  assert.equal(consent.acceptedAt, NOW.toISOString());

  const withConsent = appendConsentToCustomer(customer, consent);
  assert.equal(getConsentStatus(withConsent, config), 'VIGENTE');

  const v2 = await publishPrivacyNoticeVersion(config, {
    template: DEFAULT_PRIVACY_NOTICE_TEMPLATE + '\nNueva finalidad: avisos de promociones.',
    responsibleName: 'Guadalupe Martínez',
    contact: 'WhatsApp 971-000-0000',
    storeName: 'Abarrotes La Esperanza',
    publishedBy: 'Administrador',
  });
  assert.equal(getConsentStatus(withConsent, v2.config), 'VERSION_ANTERIOR');
});

test('K13: exportación (derecho de acceso) incluye todo lo que la tienda tiene del cliente', async () => {
  const scope = buildScope();
  const config = await buildDefaultPrivacyNoticeConfig('Abarrotes La Esperanza', NOW);
  const consent = createConsentRecord({ notice: getCurrentNoticeVersion(config)!, collectedBy: 'Don Lupe', now: NOW });
  scope.creditCustomers[0] = appendConsentToCustomer(scope.creditCustomers[0], consent);

  const res = buildCustomerDataExport(scope, 'CLI-77', {
    exportedBy: 'Administrador',
    storeName: 'Abarrotes La Esperanza',
    notice: config,
    now: NOW,
  });
  assert.equal(res.ok, true);
  const data = res.data!;
  assert.equal(data.formato, 'BTARCO-EXPORT');
  assert.equal(data.titular.nombre, 'Doña Eufrosina Matus');
  assert.equal(data.titular.telefono, '971-555-0199');
  assert.equal(data.credito.saldoActual, 245.5);
  assert.equal(data.deudas.length, 1);
  assert.equal(data.abonos.length, 1);
  assert.deepEqual(data.ventasACredito.map((v: any) => v.folio), ['V-0003']);
  assert.deepEqual(data.movimientosDeCaja.map((m: any) => m.id), ['CM1']);
  assert.equal(data.kardexRelacionado.movimientos.length, 2, 'histórico con nombre + nuevo con ID');
  assert.equal(data.privacidad.consentimientos.length, 1);
  assert.match(data.privacidad.consentimientos[0].textoDelAviso, /AVISO DE PRIVACIDAD/);
  assert.match(res.fileName!, /^datos-cliente-CLI-77-.*\.json$/);
  // Lo exportado es JSON puro (descargable).
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(data)));

  assert.equal(buildCustomerDataExport(scope, 'NO-EXISTE', { exportedBy: 'x', storeName: 'y' }).ok, false);
});

test('K14: anonimización (cancelación) borra nombre y teléfono sin romper el Kardex ni el saldo', () => {
  const scope = buildScope();
  const kardexBefore = scope.kardex;
  const kardexJsonBefore = JSON.stringify(kardexBefore);
  const products = [{ sku: 'LAC-LAL-1L', stock: 9 }];
  assert.equal(verifyKardexChain(kardexBefore, 'newest-first').valid, true);

  const res = anonymizeCustomerData(scope, 'CLI-77', { anonymizedBy: 'Administrador', now: NOW });
  assert.equal(res.ok, true);
  const next = res.scope;
  const anon = next.creditCustomers.find((c: any) => c.id === 'CLI-77');

  // Datos de identificación eliminados.
  assert.equal(anon.name, buildAnonymizedName('CLI-77'));
  assert.equal(anon.phone, '');
  assert.equal(anon.alias, undefined);
  assert.equal(anon.notes, undefined);
  assert.ok(isCustomerAnonymized(anon));
  assert.equal(anon.privacy.contactOptOut, true);
  assert.equal(anon.privacy.arcoRequests.at(-1).right, 'CANCELACION');

  // Saldo, deudas y abonos intactos (mismo ID).
  assert.equal(anon.id, 'CLI-77');
  assert.equal(anon.currentBalance, 245.5);
  assert.equal(anon.creditLimit, 800);
  assert.deepEqual(anon.debts.map((d: any) => d.remainingBalance), [245.5]);
  assert.deepEqual(anon.payments.map((p: any) => p.amount), [52]);
  assert.equal(anon.isActive, true, 'con saldo pendiente sigue activo para poder recibir abonos');

  // Kardex: misma referencia, mismo contenido, cadena y continuidad válidas.
  assert.equal(next.kardex, kardexBefore);
  assert.equal(JSON.stringify(next.kardex), kardexJsonBefore);
  assert.equal(verifyKardexChain(next.kardex, 'newest-first').valid, true);
  assert.equal(verifyProductContinuity(products, next.kardex, 'newest-first').valid, true);
  assert.equal(res.report!.kardexModified, false);
  assert.equal(res.report!.kardexEntriesRetained, 2);
  assert.equal(anon.privacy.retainedKardexEntryIds.length, 2);

  // Fuera del Kardex ya no queda el nombre, el alias ni el teléfono.
  const { kardex: _k, ...rest } = next;
  const dump = JSON.stringify(rest);
  for (const secret of ['Eufrosina', '971-555-0199', 'La del molino', 'molino de nixtamal']) {
    assert.ok(!dump.includes(secret), `"${secret}" no debe quedar fuera del Kardex`);
  }
  assert.equal(next.salesHistory[0].customerName, buildAnonymizedName('CLI-77'));
  assert.match(next.cashMovements[0].reason, /Cliente anonimizado CLI-77/);
  assert.equal(next.cashMovements[1].reason, 'Pago de garrafón');
  assert.equal(next.morningAlerts[0].title, 'Cobrar a Cliente anonimizado CLI-77');

  // Los demás clientes no se tocan.
  assert.deepEqual(next.creditCustomers[1], scope.creditCustomers[1]);
  assert.equal(next.salesHistory[1].customerName, 'Taller Mecánico El Istmo');

  // No se puede anonimizar dos veces; sin saldo queda inactivo.
  assert.equal(anonymizeCustomerData(next, 'CLI-77', { anonymizedBy: 'Administrador' }).ok, false);
  const paidScope = buildScope();
  paidScope.creditCustomers[0] = { ...paidScope.creditCustomers[0], currentBalance: 0 };
  const paid = anonymizeCustomerData(paidScope, 'CLI-77', { anonymizedBy: 'Administrador' });
  assert.equal(paid.scope.creditCustomers[0].isActive, false);
});

test('K15: oposición y búsqueda de movimientos del Kardex ligados al cliente', () => {
  const scope = buildScope();
  const customer = scope.creditCustomers[0];
  const opposed = registerOpposition(customer, { scope: 'RECORDATORIOS', registeredBy: 'Don Lupe', note: 'No quiere mensajes', now: NOW });
  assert.equal(opposed.privacy.contactOptOut, true);
  assert.equal(opposed.privacy.oppositions.length, 1);
  assert.equal(opposed.privacy.arcoRequests[0].right, 'OPOSICION');
  assert.equal(opposed.name, 'Doña Eufrosina Matus', 'la oposición no borra datos');

  const linked = findKardexEntriesForCustomer(scope.kardex, customer);
  assert.deepEqual(linked.map((k) => k.type).sort(), ['ABONO_FIADO', 'VENTA_FIADO']);
});
