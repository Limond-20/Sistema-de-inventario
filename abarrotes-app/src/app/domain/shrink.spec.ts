import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addShrinkRecordIdempotent, type ShrinkRecordLike } from './shrink.ts';

test('addShrinkRecordIdempotent - caso 1: registro nuevo', () => {
  const listaInicial: ShrinkRecordLike[] = [
    { id: 'M-0001', name: 'Leche Lala Entera 1L', qty: 1, unitCost: 21 },
  ];
  const nuevoRegistro: ShrinkRecordLike = {
    id: 'M-0002',
    name: 'Pan Bimbo Blanco',
    qty: 2,
    unitCost: 41,
  };

  const resultado = addShrinkRecordIdempotent(listaInicial, nuevoRegistro);

  assert.equal(resultado.length, 2, 'La lista debe contener 2 registros');
  assert.equal(resultado[0].id, 'M-0002', 'El nuevo registro debe colocarse al inicio');
  assert.equal(resultado[1].id, 'M-0001');
  assert.notEqual(resultado, listaInicial, 'Debe devolver un nuevo arreglo inmutable');
});

test('addShrinkRecordIdempotent - caso 2: duplicado (mismo id)', () => {
  const listaInicial: ShrinkRecordLike[] = [
    { id: 'M-0001', name: 'Leche Lala Entera 1L', qty: 1, unitCost: 21 },
    { id: 'M-0002', name: 'Pan Bimbo Blanco', qty: 2, unitCost: 41 },
  ];
  const registroDuplicado: ShrinkRecordLike = {
    id: 'M-0001',
    name: 'Leche Lala Entera 1L (retransmisión)',
    qty: 1,
    unitCost: 21,
  };

  const resultado = addShrinkRecordIdempotent(listaInicial, registroDuplicado);

  assert.equal(resultado.length, 2, 'No debe incrementar la longitud ante un duplicado');
  assert.deepEqual(resultado, listaInicial, 'El contenido debe permanecer idéntico');
});

test('addShrinkRecordIdempotent - caso 3: dos registros distintos de forma secuencial', () => {
  const listaInicial: ShrinkRecordLike[] = [];
  const registroA: ShrinkRecordLike = { id: 'M-0100', name: 'Huevo Blanco 1kg', qty: 1, unitCost: 36 };
  const registroB: ShrinkRecordLike = { id: 'M-0101', name: 'Atún Dolores', qty: 3, unitCost: 16.5 };

  const trasPrimero = addShrinkRecordIdempotent(listaInicial, registroA);
  assert.equal(trasPrimero.length, 1);
  assert.equal(trasPrimero[0].id, 'M-0100');

  const trasSegundo = addShrinkRecordIdempotent(trasPrimero, registroB);
  assert.equal(trasSegundo.length, 2);
  assert.equal(trasSegundo[0].id, 'M-0101');
  assert.equal(trasSegundo[1].id, 'M-0100');
});
