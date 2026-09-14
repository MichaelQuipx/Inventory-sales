const test = require('node:test');
const assert = require('node:assert/strict');
const { toCsv, parseCsv, parseCsvRecords } = require('../src/csv');

test('toCsv/parseCsv round-trip through commas, quotes, and embedded newlines', () => {
  const rows = [
    { name: 'Jasmine Rice, 50kg', note: 'Contains "quotes" and,\ncommas', price: 58 },
    { name: 'Plain Item', note: '', price: 12.5 }
  ];
  const columns = [
    { label: 'Name', value: (row) => row.name },
    { label: 'Note', value: (row) => row.note },
    { label: 'Price', value: (row) => row.price }
  ];
  const csv = toCsv(columns, rows);
  const parsed = parseCsv(csv);
  assert.deepEqual(parsed[0], ['Name', 'Note', 'Price']);
  assert.deepEqual(parsed[1], ['Jasmine Rice, 50kg', 'Contains "quotes" and,\ncommas', '58']);
  assert.deepEqual(parsed[2], ['Plain Item', '', '12.5']);
});

test('parseCsvRecords normalizes headers to lowercase/trimmed keys', () => {
  const records = parseCsvRecords('Product Name, Selling Price ,Stock\nRice,58,50\n');
  assert.deepEqual(records, [{ 'product name': 'Rice', 'selling price': '58', stock: '50' }]);
});

test('parseCsv handles \\r\\n line endings and a trailing newline', () => {
  const records = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
  assert.deepEqual(records, [['a', 'b'], ['1', '2'], ['3', '4']]);
});

test('parseCsv strips a leading BOM (common in Excel-exported CSVs)', () => {
  const records = parseCsv('\uFEFFa,b\n1,2\n');
  assert.deepEqual(records[0], ['a', 'b']);
});

test('toCsv on an empty row set still returns just the header', () => {
  const csv = toCsv([{ label: 'Name', value: (row) => row.name }], []);
  assert.equal(csv, 'Name\r\n');
});
