const test = require('node:test');
const assert = require('node:assert/strict');
const { looksLikeThermalPrinter, pickPrinter } = require('../src/printers');

const list = (...names) => names.map((name, index) => ({ name, isDefault: index === 0, looksThermal: looksLikeThermalPrinter({ name }) }));

test('thermal receipt printers are recognised by name', () => {
  for (const name of ['POS-58', 'XP-58IIH', 'Generic Thermal Printer', 'RONGTA RP58', 'EPSON TM-T20']) assert.ok(looksLikeThermalPrinter({ name }), name);
  for (const name of ['Microsoft Print to PDF', 'HP LaserJet Pro', 'OneNote']) assert.ok(!looksLikeThermalPrinter({ name }), name);
});

test('pickPrinter prefers the saved printer, then a 58mm thermal, then the default', () => {
  const printers = list('Microsoft Print to PDF', 'HP LaserJet', 'POS-58');
  assert.equal(pickPrinter(printers, 'HP LaserJet').name, 'HP LaserJet');
  assert.equal(pickPrinter(printers, 'Removed Printer').name, 'POS-58');
  assert.equal(pickPrinter(list('Microsoft Print to PDF', 'HP LaserJet'), '').name, 'Microsoft Print to PDF');
  assert.equal(pickPrinter([], ''), null);
});
