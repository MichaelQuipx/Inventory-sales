const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReceiptHtml } = require('../src/receipt');

const sampleSale = {
  id: 'KJ-0001',
  createdAt: '2026-09-12T10:30:00.000Z',
  total: 174.5,
  userId: 'user-1',
  items: [
    { productName: 'Jasmine Rice', unit: 'kg', quantity: 2, unitPrice: 58, subtotal: 116 },
    { productName: 'A Very Long Product Name That Should Wrap Across Multiple Lines On A Narrow Thermal Receipt', unit: 'pc', quantity: 1, unitPrice: 58.5, subtotal: 58.5 }
  ]
};

test('buildReceiptHtml includes the sale ID, items, and total', () => {
  const html = buildReceiptHtml(sampleSale, { paperWidth: '80mm', processedByName: 'Michael' });
  assert.match(html, /KJ-0001/);
  assert.match(html, /Jasmine Rice/);
  assert.match(html, /Michael/);
  assert.match(html, /174\.50/);
});

test('buildReceiptHtml sets the correct @page size for each supported width', () => {
  assert.match(buildReceiptHtml(sampleSale, { paperWidth: '58mm' }), /@page \{ size: 58mm auto/);
  assert.match(buildReceiptHtml(sampleSale, { paperWidth: '80mm' }), /@page \{ size: 80mm auto/);
  // Unknown width falls back to 80mm rather than producing broken CSS.
  assert.match(buildReceiptHtml(sampleSale, { paperWidth: 'bogus' }), /@page \{ size: 80mm auto/);
});

test('buildReceiptHtml omits Discount/Payment/Change since those fields do not exist on a sale', () => {
  const html = buildReceiptHtml(sampleSale, { paperWidth: '80mm' });
  assert.doesNotMatch(html, /Discount/i);
  assert.doesNotMatch(html, /Payment/i);
  assert.doesNotMatch(html, /Change/i);
});

test('buildReceiptHtml escapes product names to prevent HTML injection', () => {
  const sale = { ...sampleSale, items: [{ productName: '<script>alert(1)</script>', unit: 'pc', quantity: 1, unitPrice: 10, subtotal: 10 }] };
  const html = buildReceiptHtml(sale, { paperWidth: '80mm' });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('buildReceiptHtml works even when processedByName is not provided', () => {
  const html = buildReceiptHtml(sampleSale, { paperWidth: '80mm' });
  assert.doesNotMatch(html, /Processed By/);
});
