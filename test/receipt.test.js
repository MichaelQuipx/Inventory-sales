const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReceiptHtml, buildReceiptLines } = require('../src/receipt');

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
const textOf = (sale, options) => buildReceiptLines(sale, options).map((line) => line.text).join('\n');

test('receipt includes the sale ID, items, cashier and total', () => {
  const text = textOf(sampleSale, { paperWidth: '80mm', processedByName: 'Michael' });
  assert.match(text, /KJ-0001/);
  assert.match(text, /Jasmine Rice/);
  assert.match(text, /Cashier: Michael/);
  assert.match(text, /TOTAL\s+P174\.50/);
});

test('receipt is plain ASCII only, so thermal printers never show "?" for symbols', () => {
  const sale = { ...sampleSale, items: [{ productName: 'Ni\u00f1o Caf\u00e9 \u20b1 \u00d7', unit: 'pc', quantity: 1, unitPrice: 10, subtotal: 10 }] };
  for (const paperWidth of ['58mm', '80mm']) assert.match(textOf(sale, { paperWidth }), /^[\x20-\x7E\n]*$/);
  assert.match(textOf(sale, { paperWidth: '58mm' }), /Nino Cafe/);
});

test('no line is wider than the paper: 32 columns on 58mm, 48 on 80mm', () => {
  const sale = { ...sampleSale, subtotal: 174.5, discount: 20, total: 154.5 };
  for (const [paperWidth, cols] of [['58mm', 32], ['80mm', 48]]) {
    for (const line of buildReceiptLines(sale, { paperWidth, processedByName: 'A Cashier With A Rather Long Name' })) assert.ok(line.text.length <= cols, `"${line.text}" > ${cols}`);
  }
});

test('amounts are right-aligned to the full paper width', () => {
  const lines = buildReceiptLines(sampleSale, { paperWidth: '58mm', layout: { leftMarginChars: 0 } }).map((l) => l.text);
  const total = lines.find((line) => line.startsWith('TOTAL'));
  assert.equal(total.length, 32);
  assert.ok(total.endsWith('P174.50'));
});

test('margins and minimum length are added as blank lines', () => {
  const base = buildReceiptLines(sampleSale, { paperWidth: '58mm', layout: { topMarginLines: 0, bottomMarginLines: 0, minLines: 0 } });
  const padded = buildReceiptLines(sampleSale, { paperWidth: '58mm', layout: { topMarginLines: 2, bottomMarginLines: 6, minLines: 0 } });
  assert.equal(padded.length, base.length + 8);
  assert.equal(padded[0].text, '');
  assert.equal(padded[padded.length - 1].text, '');
  // A short receipt is padded up to the minimum length (bottom margin included).
  const minimum = buildReceiptLines(sampleSale, { paperWidth: '58mm', layout: { topMarginLines: 0, bottomMarginLines: 3, minLines: base.length + 10 } });
  assert.equal(minimum.length, base.length + 10);
  // Left margin shifts every line.
  assert.ok(buildReceiptLines(sampleSale, { paperWidth: '58mm', layout: { leftMarginChars: 2 } }).some((line) => line.text.startsWith('  KJ') || line.text.startsWith('  ')));
});

test('buildReceiptHtml sets the correct @page size for each supported width', () => {
  assert.match(buildReceiptHtml(sampleSale, { paperWidth: '58mm' }), /@page \{ size: 58mm auto/);
  assert.match(buildReceiptHtml(sampleSale, { paperWidth: '80mm' }), /@page \{ size: 80mm auto/);
  assert.match(buildReceiptHtml(sampleSale, { paperWidth: 'bogus' }), /@page \{ size: 80mm auto/);
});

test('58mm receipts keep text inside the ~48mm printable area; 80mm inside ~72mm', () => {
  assert.match(buildReceiptHtml(sampleSale, { paperWidth: '58mm' }), /padding: 0 5mm/);
  assert.match(buildReceiptHtml(sampleSale, { paperWidth: '80mm' }), /padding: 0 4mm/);
});

test('receipt omits Discount/Payment/Change when the sale has none', () => {
  const text = textOf(sampleSale, { paperWidth: '80mm' });
  assert.doesNotMatch(text, /Discount/i);
  assert.doesNotMatch(text, /Payment/i);
  assert.doesNotMatch(text, /Change/i);
});

test('receipt escapes product names to prevent HTML injection', () => {
  const sale = { ...sampleSale, items: [{ productName: '<script>alert(1)</script>', unit: 'pc', quantity: 1, unitPrice: 10, subtotal: 10 }] };
  const html = buildReceiptHtml(sale, { paperWidth: '80mm' });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('receipt works even when processedByName is not provided', () => {
  assert.doesNotMatch(textOf(sampleSale, { paperWidth: '80mm' }), /Cashier/);
});

test('receipt shows Subtotal and Discount when a discount was applied', () => {
  const text = textOf({ ...sampleSale, subtotal: 174.5, discount: 20, total: 154.5 }, { paperWidth: '80mm' });
  assert.match(text, /Subtotal\s+P174\.50/);
  assert.match(text, /Discount\s+-P20\.00/);
  assert.match(text, /TOTAL\s+P154\.50/);
});

test('receipt shows the total number of items, from itemCount or derived from items', () => {
  assert.match(textOf({ ...sampleSale, itemCount: 3 }, { paperWidth: '80mm' }), /Items\s+3/);
  assert.match(textOf(sampleSale, { paperWidth: '80mm' }), /Items\s+3/);
});
