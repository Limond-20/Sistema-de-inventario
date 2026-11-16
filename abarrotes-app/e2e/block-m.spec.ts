import { expect, test } from '@playwright/test';

const supervisorPin = '839201';
const backupPassphrase = 'respaldo-e2e-2026';
const productName = 'Producto E2E Persistente';
const temporaryProductName = 'Producto E2E Temporal';

async function createProduct(page: import('@playwright/test').Page, name: string, sku: string, stock: number) {
  await page.goto('/catalogo');
  await page.getByTestId('btn-new-product').click();
  await page.getByTestId('input-product-name').fill(name);
  await page.getByTestId('input-product-sku').fill(sku);
  await page.getByTestId('input-product-cost').fill('10');
  await page.getByTestId('input-product-price').fill('20');
  await page.getByTestId('input-initial-stock').fill(String(stock));
  if (stock > 0) await page.getByTestId('input-catalog-pin').fill(supervisorPin);
  await page.getByTestId('btn-save-product').click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
}

test('Bloque M: flujos reales PC-celular, operaciones, respaldo y persistencia', async ({ browser, page }) => {
  const phoneContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const phone = await phoneContext.newPage();

  try {
    await page.goto('/pos');
    await expect(page.getByPlaceholder('Escanear código de barras o escribir producto...')).toBeVisible();

    const pairing = await page.evaluate(async () => {
      const response = await fetch('/api/pairing');
      if (!response.ok) throw new Error('No se pudo obtener el código de vinculación.');
      return response.json() as Promise<{ token: string; url: string }>;
    });
    const phoneUrl = new URL(pairing.url);
    expect(['localhost', '127.0.0.1', '::1']).not.toContain(phoneUrl.hostname);
    phoneUrl.pathname = '/movil-prototipo.html';
    phoneUrl.search = new URLSearchParams({ t: pairing.token }).toString();
    await phone.goto(phoneUrl.toString(), { waitUntil: 'domcontentloaded' });
    await expect(phone.getByRole('heading', { name: 'Terminal de Mostrador y Pasillo' })).toBeVisible();
    await expect.poll(() => phone.evaluate(() => (window as any).LanSync?.snapshot())).toMatchObject({
      role: 'phone',
      status: 'open',
    });

    await page.locator('aside').getByRole('button').filter({ hasText: /celular|QR|vincular/i }).click();
    await expect(page.getByText('1 celular enlazado en vivo')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cerrar' }).click();

    await createProduct(page, productName, 'E2E-PRO-01', 20);

    await page.goto('/pos');
    const search = page.getByPlaceholder('Escanear código de barras o escribir producto...');
    await search.fill(productName);
    await page.getByRole('button', { name: 'Buscar / Agregar' }).click();
    await expect(page.getByText(productName).first()).toBeVisible();
    await page.getByRole('button', { name: /Cobrar Efectivo/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Exacto' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirmar y Cobrar' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await search.fill(productName);
    await page.getByRole('button', { name: 'Buscar / Agregar' }).click();
    await page.getByRole('button', { name: 'Cargar a Crédito' }).click();
    const creditDialog = page.getByRole('dialog');
    const eligibleCustomer = creditDialog.locator('button').filter({ hasText: 'Al Corriente' }).first();
    const customerName = (await eligibleCustomer.innerText()).split('\n')[0].trim();
    await eligibleCustomer.click();
    await creditDialog.getByRole('button', { name: /^Autorizar y Cargar/ }).click();
    await expect(creditDialog).toBeHidden();

    await page.getByRole('button', { name: 'Recibir Abono de Crédito Vecinal' }).click();
    const abonoDialog = page.getByRole('dialog');
    const customerSelect = abonoDialog.getByText('Cliente que abona:').locator('..').locator('select');
    const customerOptions = await customerSelect.locator('option').allTextContents();
    const customerIndex = customerOptions.findIndex((option) => option.startsWith(customerName));
    expect(customerIndex).toBeGreaterThanOrEqual(0);
    await customerSelect.selectOption({ index: customerIndex });
    await abonoDialog.getByText('Monto entregado ($):').locator('..').locator('input').fill('10');
    await abonoDialog.getByRole('button', { name: 'Registrar Abono' }).click();
    await expect(abonoDialog.getByText('ABONO REGISTRADO CON ÉXITO')).toBeVisible();
    await abonoDialog.getByRole('button', { name: 'Aceptar' }).click();
    await abonoDialog.getByRole('button', { name: 'Cerrar' }).click();

    await page.goto('/recepcion');
    await page.getByRole('tab', { name: /Captura Manual de Factura/ }).click();
    const receivingForm = page.locator('section').filter({ hasText: 'Agregar producto recibido en mostrador' });
    const receivedProducts = await receivingForm.locator('select option').allTextContents();
    const receivedProductIndex = receivedProducts.findIndex((option) => option.includes(productName));
    expect(receivedProductIndex).toBeGreaterThanOrEqual(0);
    await receivingForm.locator('select').selectOption({ index: receivedProductIndex });
    await receivingForm.getByRole('button', { name: 'Agregar uno' }).click();
    await receivingForm.locator('input[type="number"]').fill('18');
    await receivingForm.getByRole('button', { name: '+ Agregar' }).click();
    await page.getByRole('button', { name: /Ajustar Precio a/ }).click();
    await page.getByRole('button', { name: 'Guardar Entrada en Inventario' }).click();
    await expect(page.getByText('Mercancía registrada con éxito')).toBeVisible();

    await phone.getByRole('button', { name: /Reporte de Mermas/ }).click();
    await phone.getByRole('button', { name: 'Empaque Roto' }).click();
    await phone.locator('#merma-prod-select').selectOption('ACE-NUT-850');
    await phone.locator('#merma-photo-file').setInputFiles({
      name: 'evidencia.png',
      mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq7sAAAAASUVORK5CYII=', 'base64'),
    });
    await expect(phone.locator('#merma-photo-preview-wrap')).toBeVisible();
    const evidenceUpload = phone.waitForResponse((response) => response.url().endsWith('/api/evidencia') && response.request().method() === 'POST');
    await phone.locator('#btn-merma-submit').click();
    expect((await evidenceUpload).ok()).toBeTruthy();
    await page.goto('/mermas');
    await expect(page.locator('article').filter({ hasText: 'ACE-NUT-850' })).toBeVisible();
    await expect(page.locator('article img[alt^="Evidencia #"]')).toBeVisible();

    await phone.getByRole('button', { name: 'Regresar al Menú' }).click();
    await phone.getByRole('button', { name: /Auditoría Ciega de Pasillo/ }).click();
    await phone.locator('#audit-keypad').getByRole('button', { name: '0', exact: true }).click();
    await phone.locator('#btn-audit-next').click();
    for (let item = 2; item <= 15; item += 1) {
      await expect(phone.locator('#audit-step-label')).toHaveText(`Producto ${item} de 15`);
      await phone.getByRole('button', { name: 'Omitir' }).click();
    }
    await expect(phone.locator('#audit-summary-view')).toBeVisible();
    await phone.getByRole('button', { name: 'Enviar Conteo a la Computadora' }).click();

    await page.goto('/auditoria');
    const auditRow = page.locator('article').filter({ hasText: 'LAC-LAL-1L' });
    await expect(auditRow).toBeVisible();
    await auditRow.getByRole('button', { name: /Merma Normal Granel\/Corte|Autorizar Merma Natural/ }).click();
    const pinDialog = page.getByTestId('audit-pin-dialog');
    await expect(pinDialog).toBeVisible();
    await pinDialog.getByTestId('input-audit-adjustment-pin').fill('111111');
    await pinDialog.getByTestId('btn-authorize-audit-adjustment').click();
    await expect(pinDialog.getByTestId('audit-pin-error')).toBeVisible();
    await expect(auditRow.getByText(/Ajuste aplicado/)).toHaveCount(0);
    await pinDialog.getByTestId('input-audit-adjustment-pin').fill(supervisorPin);
    await pinDialog.getByTestId('btn-authorize-audit-adjustment').click();
    await expect(pinDialog).toBeHidden();
    await expect(auditRow.getByText(/Ajuste aplicado/)).toBeVisible();

    await page.getByTestId('btn-backup-now').click();
    const backupDialog = page.getByTestId('backup-modal');
    await expect(backupDialog).toBeVisible();
    await backupDialog.locator('#backup-passphrase-input').fill(backupPassphrase);
    await backupDialog.getByTestId('modal-btn-backup-now').click();
    await expect(backupDialog.getByRole('button', { name: 'Restaurar' })).toBeVisible();

    await createProduct(page, temporaryProductName, 'E2E-PRO-02', 0);
    await page.getByTestId('btn-backup-now').click();
    const restoreButtons = page.getByTestId('backup-modal').getByRole('button', { name: 'Restaurar' });
    await expect(restoreButtons).toHaveCount(2);
    await restoreButtons.last().click();
    await page.locator('#restore-passphrase-input').fill(backupPassphrase);
    await page.getByTestId('btn-confirm-restore').click();
    await expect(page.getByTestId('restore-confirm-box')).toBeHidden();
    await page.getByTestId('backup-modal').getByRole('button', { name: 'Cerrar' }).click();

    await page.reload();
    await expect(page.getByTestId('hydration-loading-screen')).toBeHidden();
    await page.goto('/catalogo');
    await expect(page.getByText(productName, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(temporaryProductName, { exact: true })).toHaveCount(0);
    await page.goto('/mermas');
    await expect(page.locator('article').filter({ hasText: 'ACE-NUT-850' })).toBeVisible();
  } finally {
    await phoneContext.close();
  }
});