const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createStore } = require('../src/store');

function testStore() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kj-store-test-'));
  const databasePath = path.join(folder, 'data.json');
  return { store: createStore(databasePath), folder, databasePath };
}

// Most store operations now require an authenticated user. This spins up a
// store, seeds the default Super Admin (via initialize), and logs in.
function authenticatedStore() {
  const context = testStore();
  context.store.initialize();
  const admin = context.store.authenticate('admin', 'Admin123!');
  return { ...context, admin };
}

test('product creation, sale completion, history, and stock deduction work together', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const product = store.createProduct({ name: 'Galvanized Nails', sku: 'HW-001', category: 'Hardware', price: 45.5, stock: 10, lowStockThreshold: 3 });
    assert.equal(store.getData().products.length, 1);
    const sale = store.completeSale([{ productId: product.id, quantity: 3 }], admin.id);
    assert.equal(sale.total, 136.5);
    assert.equal(sale.itemCount, 3);
    assert.equal(sale.userId, admin.id);
    const secondSale = store.completeSale([{ productId: product.id, quantity: 1 }], admin.id);
    assert.equal(secondSale.total, 45.5);
    assert.equal(store.getData().products[0].stock, 6);
    assert.equal(store.listSales({}).length, 2);
    assert.equal(store.getSale(sale.id).items[0].productName, 'Galvanized Nails');
    const dashboard = store.dashboard('daily');
    assert.equal(dashboard.summary.totalSales, 182);
    assert.equal(dashboard.summary.transactionCount, 2);
    assert.equal(dashboard.summary.productsSold, 4);
    assert.equal(dashboard.summary.averageSale, 91);
    assert.equal(dashboard.graph.reduce((sum, point) => sum + point.total, 0), 182);
    for (const period of ['daily', 'weekly', 'monthly', 'yearly']) {
      const graph = store.dashboard(period).graph;
      assert.ok(graph.length > 0);
      assert.equal(graph.reduce((sum, point) => sum + point.total, 0), 182);
      assert.ok(graph.every((point) => point.tooltip));
    }
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('sales preserve their snapshots after a product is archived', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const product = store.createProduct({ name: 'Starter Feed', category: 'Hog & Chicken Feeds', price: 900, stock: 4, lowStockThreshold: 1 });
    const sale = store.completeSale([{ productId: product.id, quantity: 1 }], admin.id);
    store.archiveProduct(product.id);
    assert.equal(store.getData().products[0].archived, true);
    assert.equal(store.getSale(sale.id).items[0].unitPrice, 900);
    assert.equal(store.dashboard().summary.averageSale, 900);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('sample records are created only for an empty store', () => {
  const { store, folder } = testStore();
  try {
    assert.equal(store.seedDemoData(), true);
    const data = store.getData();
    assert.equal(data.products.length, 10);
    assert.equal(data.sales.length, 5);
    assert.ok(data.sales.some((sale) => sale.id === 'KJ-DEMO-001'));
    const expectedTotal = data.sales.reduce((sum, sale) => sum + sale.total, 0);
    const expectedLabels = { daily: /^\w{3} \d+$/, weekly: /^Week of /, monthly: /^\w{3}$/, yearly: /^\d{4}$/ };
    for (const period of ['daily', 'weekly', 'monthly', 'yearly']) {
      const graph = store.dashboard(period).graph;
      assert.equal(graph.reduce((sum, point) => sum + point.total, 0), expectedTotal);
      assert.ok(graph.every((point) => expectedLabels[period].test(point.label)));
    }
    assert.equal(store.seedDemoData(), false);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('dashboard filters use completed sales and inclusive local calendar dates', () => {
  const { store, folder, databasePath } = testStore();
  try {
    store.seedDemoData();
    const rawData = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
    rawData.sales.push({ id: 'CANCELLED-DEMO', createdAt: new Date().toISOString(), status: 'Cancelled', itemCount: 99, total: 999999, items: [] });
    fs.writeFileSync(databasePath, JSON.stringify(rawData), 'utf8');
    const sales = store.getData().sales;
    const types = ['today', 'yesterday', 'this-week', 'last-7-days', 'this-month', 'last-30-days', 'this-year', 'daily', 'weekly', 'monthly', 'yearly'];
    for (const type of types) {
      const dashboard = store.dashboard({ type });
      const inRange = sales.filter((sale) => sale.status === 'Completed' && new Date(sale.createdAt) >= new Date(dashboard.filter.start) && new Date(sale.createdAt) < new Date(dashboard.filter.end));
      const total = inRange.reduce((sum, sale) => sum + sale.total, 0);
      const items = inRange.reduce((sum, sale) => sum + sale.itemCount, 0);
      assert.equal(dashboard.summary.totalSales, total, `${type} total`);
      assert.equal(dashboard.summary.transactionCount, inRange.length, `${type} transaction count`);
      assert.equal(dashboard.summary.productsSold, items, `${type} items sold`);
      assert.equal(dashboard.graph.reduce((sum, point) => sum + point.total, 0), total, `${type} graph total`);
    }
    const saleDate = sales[0].createdAt.slice(0, 10);
    const custom = store.dashboard({ type: 'custom', start: saleDate, end: saleDate });
    assert.equal(custom.summary.transactionCount, 1);
    assert.equal(custom.summary.totalSales, sales[0].total);
    assert.equal(store.dashboard().filter.type, 'this-week');
    const awaitingRange = store.dashboard({ type: 'custom' });
    assert.equal(awaitingRange.summary.transactionCount, 0);
    assert.equal(awaitingRange.graph.length, 0);
    const noSales = store.dashboard({ type: 'custom', start: '2000-01-01', end: '2000-01-02' });
    assert.equal(noSales.summary.totalSales, 0);
    assert.equal(noSales.summary.transactionCount, 0);
    assert.equal(noSales.insights.best, null);
    assert.equal(noSales.insights.lowest, null);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('initialize seeds a default Super Admin exactly once', () => {
  const { store, folder } = testStore();
  try {
    assert.equal(store.listUsers().length, 0);
    store.initialize();
    assert.equal(store.listUsers().length, 1);
    assert.equal(store.listUsers()[0].role, 'super-admin');
    store.initialize();
    assert.equal(store.listUsers().length, 1, 'initialize should not duplicate the seeded admin');
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('authenticate rejects invalid credentials and never leaks the password hash', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    assert.equal(admin.username, 'admin');
    assert.equal(admin.passwordHash, undefined);
    assert.throws(() => store.authenticate('admin', 'wrong-password'), /Invalid username or password/);
    assert.throws(() => store.authenticate('nobody', 'Admin123!'), /Invalid username or password/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('a deactivated user cannot authenticate', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const staff = store.createUser({ name: 'Regular Staff', username: 'staff', password: 'Password123', role: 'regular-user' });
    store.updateUser(staff.id, { name: staff.name, username: staff.username, role: staff.role, active: false });
    assert.throws(() => store.authenticate('staff', 'Password123'), /Invalid username or password/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('usernames must be unique across users', () => {
  const { store, folder } = authenticatedStore();
  try {
    store.createUser({ name: 'First Cashier', username: 'cashier', password: 'Password123', role: 'regular-user' });
    assert.throws(() => store.createUser({ name: 'Second Cashier', username: 'cashier', password: 'Password123', role: 'regular-user' }), /already in use/);
    assert.throws(() => store.createUser({ name: 'Second Cashier', username: 'CASHIER', password: 'Password123', role: 'regular-user' }), /already in use/, 'usernames should be compared case-insensitively');
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('the last active Super Admin cannot be demoted or deactivated', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    assert.throws(() => store.updateUser(admin.id, { name: admin.name, username: admin.username, role: 'regular-user', active: true }), /at least one active Super Admin/);
    assert.throws(() => store.updateUser(admin.id, { name: admin.name, username: admin.username, role: 'super-admin', active: false }), /at least one active Super Admin/);
    const secondAdmin = store.createUser({ name: 'Second Admin', username: 'admin2', password: 'Password123', role: 'super-admin' });
    // With two active admins, demoting the first is fine.
    const updated = store.updateUser(admin.id, { name: admin.name, username: admin.username, role: 'regular-user', active: true });
    assert.equal(updated.role, 'regular-user');
    assert.equal(secondAdmin.role, 'super-admin');
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('a sale always records the processing user, and history exposes it', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const cashier = store.createUser({ name: 'Cashier One', username: 'cashier1', password: 'Password123', role: 'regular-user' });
    const product = store.createProduct({ name: 'PVC Pipe', category: 'Hardware', price: 100, stock: 10, lowStockThreshold: 2 });
    const adminSale = store.completeSale([{ productId: product.id, quantity: 1 }], admin.id);
    const cashierSale = store.completeSale([{ productId: product.id, quantity: 2 }], cashier.id);
    assert.equal(adminSale.userId, admin.id);
    assert.equal(cashierSale.userId, cashier.id);
    assert.equal(store.getSale(adminSale.id).userId, admin.id);
    assert.throws(() => store.completeSale([{ productId: product.id, quantity: 1 }], 'not-a-real-user'), /session is no longer active/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('dashboard can be filtered to a single user\u2019s sales', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const cashier = store.createUser({ name: 'Cashier One', username: 'cashier1', password: 'Password123', role: 'regular-user' });
    const product = store.createProduct({ name: 'PVC Pipe', category: 'Hardware', price: 100, stock: 10, lowStockThreshold: 2 });
    store.completeSale([{ productId: product.id, quantity: 1 }], admin.id);
    store.completeSale([{ productId: product.id, quantity: 2 }], cashier.id);
    const everyone = store.dashboard({ type: 'this-week' });
    const cashierOnly = store.dashboard({ type: 'this-week', userId: cashier.id });
    assert.equal(everyone.summary.transactionCount, 2);
    assert.equal(cashierOnly.summary.transactionCount, 1);
    assert.equal(cashierOnly.summary.totalSales, 200);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('signing in is remembered across restarts until logout', () => {
  const { store, folder, databasePath, admin } = authenticatedStore();
  try {
    assert.deepEqual(store.getSession(), admin);
    // Simulate the app restarting: a fresh store instance reading the same file.
    const reopened = createStore(databasePath);
    assert.deepEqual(reopened.getSession(), admin);
    reopened.clearSession();
    assert.equal(store.getSession(), null);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('a fractional-unit product (e.g. rice by the kg) allows decimal stock and sale quantities', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    // 1 sack of Jasmine Rice = 50kg. It's tracked and sold in kg, so a fresh
    // sack is restocked as "+50 kg", not "+1 sack".
    const rice = store.createProduct({ name: 'Jasmine Rice', category: 'Rice', unit: 'kg', price: 58, stock: 50, lowStockThreshold: 5 });
    assert.equal(rice.unit, 'kg');
    const sale = store.completeSale([{ productId: rice.id, quantity: 2 }], admin.id);
    assert.equal(sale.total, 116);
    assert.equal(store.getData().products[0].stock, 48);

    // Repeated small fractional sales should not drift due to floating point error.
    for (let i = 0; i < 10; i += 1) store.completeSale([{ productId: rice.id, quantity: 0.1 }], admin.id);
    assert.equal(store.getData().products[0].stock, 47);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('a whole-unit product still rejects fractional stock and sale quantities', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const cement = store.createProduct({ name: 'Portland Cement', category: 'Hardware', unit: 'sack', price: 250, stock: 20, lowStockThreshold: 3 });
    assert.throws(() => store.updateProduct(cement.id, { name: cement.name, category: cement.category, unit: 'sack', price: 250, stock: 4.5, lowStockThreshold: 3 }), /whole number of sacks/);
    assert.throws(() => store.completeSale([{ productId: cement.id, quantity: 1.5 }], admin.id), /sold by the sack/);
    // A whole sale still works normally.
    const sale = store.completeSale([{ productId: cement.id, quantity: 2 }], admin.id);
    assert.equal(sale.total, 500);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('products without a unit (created before this feature) default to piece and keep working', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const legacyProduct = store.createProduct({ name: 'Flashlight', category: 'Hardware', price: 150, stock: 10, lowStockThreshold: 2 });
    assert.equal(legacyProduct.unit, 'piece');
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('salesReport aggregates totals and breakdowns by date, product, category, and user', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const cashier = store.createUser({ name: 'Cashier One', username: 'cashier1', password: 'Password123', role: 'regular-user' });
    const rice = store.createProduct({ name: 'Jasmine Rice', category: 'Rice', unit: 'kg', price: 58, costPrice: 45, stock: 100, lowStockThreshold: 5 });
    const nails = store.createProduct({ name: 'Galvanized Nails', category: 'Hardware', price: 45.5, stock: 50, lowStockThreshold: 5 });
    store.completeSale([{ productId: rice.id, quantity: 2 }], admin.id);
    store.completeSale([{ productId: nails.id, quantity: 3 }, { productId: rice.id, quantity: 1 }], cashier.id);

    const report = store.salesReport({ type: 'this-week' });
    assert.equal(report.summary.transactionCount, 2);
    assert.equal(report.summary.totalSales, 116 + (45.5 * 3 + 58));
    assert.equal(report.byUser.length, 2);
    assert.equal(report.byUser.find((entry) => entry.userId === admin.id).transactionCount, 1);
    assert.equal(report.byProduct.find((entry) => entry.productId === rice.id).quantitySold, 3);
    assert.equal(report.byCategory.find((entry) => entry.category === 'Rice').totalSales, 58 * 3);
    assert.equal(report.byDate.length, 1);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('inventoryReport reports low stock, out of stock, and value at cost/retail', () => {
  const { store, folder } = authenticatedStore();
  try {
    store.createProduct({ name: 'Jasmine Rice', category: 'Rice', unit: 'kg', price: 58, costPrice: 45, stock: 10, lowStockThreshold: 20 });
    store.createProduct({ name: 'Galvanized Nails', category: 'Hardware', price: 45.5, costPrice: 30, stock: 0, lowStockThreshold: 5 });
    store.createProduct({ name: 'Motor Oil', category: 'Motorparts', price: 250, costPrice: 180, stock: 40, lowStockThreshold: 5 });

    const report = store.inventoryReport();
    assert.equal(report.summary.totalProducts, 3);
    assert.equal(report.summary.lowStockCount, 1);
    assert.equal(report.summary.outOfStockCount, 1);
    assert.equal(report.summary.inventoryValueAtCost, (10 * 45) + (0 * 30) + (40 * 180));
    assert.equal(report.summary.inventoryValueAtRetail, (10 * 58) + (0 * 45.5) + (40 * 250));
    assert.equal(report.lowStock[0].name, 'Jasmine Rice');
    assert.equal(report.outOfStock[0].name, 'Galvanized Nails');
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('previewImport validates rows, flags duplicates by SKU, and never writes to disk', () => {
  const { store, folder } = authenticatedStore();
  try {
    store.createProduct({ name: 'Existing Nails', sku: 'HW-001', category: 'Hardware', price: 45, stock: 10, lowStockThreshold: 5 });
    const csv = [
      'Name,SKU,Category,Selling Price,Cost Price,Stock,Unit',
      'Jasmine Rice,,Rice,58,45,50,kg',
      'Updated Nails,HW-001,Hardware,50,35,20,piece',
      'Bad Row,BAD-1,NotACategory,-5,0,abc,piece'
    ].join('\n');
    const before = store.getData().products.length;
    const preview = store.previewImport(csv);
    assert.equal(preview.totalRows, 3);
    assert.equal(preview.newCount, 1);
    assert.equal(preview.duplicateCount, 1);
    assert.equal(preview.errorCount, 1);
    assert.ok(preview.rows[2].errors.length > 0);
    // Preview must be read-only.
    assert.equal(store.getData().products.length, before);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('commitImport skips or updates duplicates per the chosen strategy, and reports a summary', () => {
  const { store, folder } = authenticatedStore();
  try {
    const existing = store.createProduct({ name: 'Existing Nails', sku: 'HW-001', category: 'Hardware', price: 45, stock: 10, lowStockThreshold: 5 });
    const csv = [
      'Name,SKU,Category,Selling Price,Cost Price,Stock,Unit',
      'Jasmine Rice,,Rice,58,45,50,kg',
      'Updated Nails,HW-001,Hardware,50,35,20,piece'
    ].join('\n');

    const skipResult = store.commitImport(csv, 'skip');
    assert.equal(skipResult.imported, 1);
    assert.equal(skipResult.skipped, 1);
    assert.equal(skipResult.updated, 0);
    assert.equal(store.getData().products.find((product) => product.id === existing.id).price, 45, 'skip strategy should not modify the existing product');

    const updateResult = store.commitImport(csv, 'update');
    // Rice was already imported above, so this second pass sees it as a
    // duplicate too (no SKU means it's always treated as new, so it will
    // actually be added again) -- what matters here is the nails update.
    assert.equal(updateResult.updated >= 1, true);
    const updatedNails = store.getData().products.find((product) => product.id === existing.id);
    assert.equal(updatedNails.price, 50);
    assert.equal(updatedNails.costPrice, 35);
    assert.equal(updatedNails.stock, 20);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('commitImport rejects rows with a SKU that repeats within the same file', () => {
  const { store, folder } = authenticatedStore();
  try {
    const csv = [
      'Name,SKU,Category,Selling Price,Cost Price,Stock,Unit',
      'Rice Bag A,DUP-1,Rice,58,45,50,kg',
      'Rice Bag B,DUP-1,Rice,60,46,30,kg'
    ].join('\n');
    const result = store.commitImport(csv, 'skip');
    assert.equal(result.imported, 1);
    assert.equal(result.errorCount, 1);
    assert.match(result.errors[0].errors[0], /Duplicate SKU within this file/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('voidSale restores stock, marks the sale Voided, and records who/why', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const rice = store.createProduct({ name: 'Jasmine Rice', category: 'Rice', unit: 'kg', price: 58, stock: 50, lowStockThreshold: 5 });
    const sale = store.completeSale([{ productId: rice.id, quantity: 5 }], admin.id);
    assert.equal(store.getData().products[0].stock, 45);

    const voided = store.voidSale(sale.id, admin.id, 'Cashier mistake');
    assert.equal(voided.status, 'Voided');
    assert.equal(voided.voidedBy, admin.id);
    assert.equal(voided.voidReason, 'Cashier mistake');
    assert.ok(voided.voidedAt);
    assert.equal(store.getData().products[0].stock, 50, 'stock should be fully restored');
    assert.equal(store.getSale(sale.id).status, 'Voided');
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('voidSale requires a reason and cannot be applied twice', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const nails = store.createProduct({ name: 'Nails', category: 'Hardware', price: 45, stock: 10, lowStockThreshold: 2 });
    const sale = store.completeSale([{ productId: nails.id, quantity: 2 }], admin.id);
    assert.throws(() => store.voidSale(sale.id, admin.id, ''), /Enter a reason/);
    assert.throws(() => store.voidSale(sale.id, admin.id, '   '), /Enter a reason/);
    store.voidSale(sale.id, admin.id, 'Wrong item scanned');
    assert.throws(() => store.voidSale(sale.id, admin.id, 'Again'), /already been voided/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('a voided sale is excluded from dashboard and report totals, but stays in listSales for the audit trail', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const nails = store.createProduct({ name: 'Nails', category: 'Hardware', price: 45, stock: 10, lowStockThreshold: 2 });
    const keptSale = store.completeSale([{ productId: nails.id, quantity: 1 }], admin.id);
    const voidedSale = store.completeSale([{ productId: nails.id, quantity: 2 }], admin.id);
    store.voidSale(voidedSale.id, admin.id, 'Customer changed mind');

    const dashboard = store.dashboard('this-week');
    assert.equal(dashboard.summary.transactionCount, 1);
    assert.equal(dashboard.summary.totalSales, 45);

    const report = store.salesReport('this-week');
    assert.equal(report.summary.transactionCount, 1);

    const allSales = store.listSales({});
    assert.equal(allSales.length, 2, 'voided sale must still appear in History for the audit trail');
    assert.equal(allSales.find((sale) => sale.id === voidedSale.id).status, 'Voided');
    assert.equal(allSales.find((sale) => sale.id === keptSale.id).status, 'Completed');
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

// ---- Sales archiving ----

function backdate(databasePath, saleId, isoDate) {
  // Test helper: reach into the hot file directly to backdate a sale, since
  // completeSale always stamps "now". Simulates a sale that actually happened
  // in the past.
  const data = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
  const sale = data.sales.find((item) => item.id === saleId);
  sale.createdAt = isoDate;
  fs.writeFileSync(databasePath, JSON.stringify(data, null, 2), 'utf8');
}

test('archiveSalesBefore moves old sales into a year file and shrinks the hot file', () => {
  const { store, folder, admin, databasePath } = authenticatedStore();
  try {
    const nails = store.createProduct({ name: 'Nails', category: 'Hardware', price: 45, stock: 100, lowStockThreshold: 5 });
    const oldSale = store.completeSale([{ productId: nails.id, quantity: 1 }], admin.id);
    backdate(databasePath, oldSale.id, '2022-03-15T10:00:00.000Z');
    const recentSale = store.completeSale([{ productId: nails.id, quantity: 1 }], admin.id);

    const result = store.archiveSalesBefore('2023-01-01T00:00:00.000Z');
    assert.equal(result.archivedCount, 1);
    assert.deepEqual(result.years, [2022]);
    assert.equal(result.remaining, 1);

    const hotSales = store.getData().sales;
    assert.equal(hotSales.length, 1);
    assert.equal(hotSales[0].id, recentSale.id);
    assert.deepEqual(store.archiveSummary(), [{ year: 2022, count: 1 }]);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('archiving nothing (no sales old enough) is a safe no-op', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const nails = store.createProduct({ name: 'Nails', category: 'Hardware', price: 45, stock: 10, lowStockThreshold: 2 });
    store.completeSale([{ productId: nails.id, quantity: 1 }], admin.id);
    const result = store.archiveSalesBefore('2000-01-01T00:00:00.000Z');
    assert.equal(result.archivedCount, 0);
    assert.equal(store.getData().sales.length, 1);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('getSale, listSales, and voidSale all still work correctly for an archived sale', () => {
  const { store, folder, admin, databasePath } = authenticatedStore();
  try {
    const rice = store.createProduct({ name: 'Jasmine Rice', category: 'Rice', unit: 'kg', price: 58, stock: 50, lowStockThreshold: 5 });
    const oldSale = store.completeSale([{ productId: rice.id, quantity: 5 }], admin.id);
    backdate(databasePath, oldSale.id, '2021-06-01T00:00:00.000Z');
    store.archiveSalesBefore('2022-01-01T00:00:00.000Z');
    assert.equal(store.getData().sales.length, 0);
    assert.equal(store.getData().products[0].stock, 45);

    // getSale finds it even though it's no longer in the hot file.
    const fetched = store.getSale(oldSale.id);
    assert.equal(fetched.id, oldSale.id);

    // listSales with no range at all does NOT include archived sales by default...
    assert.equal(store.listSales({}).length, 0);
    // ...but does when the requested range overlaps the archived year...
    assert.equal(store.listSales({ start: '2021-01-01', end: '2021-12-31' }).length, 1);
    // ...and does when includeArchived is explicitly requested with no range.
    assert.equal(store.listSales({ includeArchived: true }).length, 1);

    // Voiding an archived sale restores stock and updates the archive file itself.
    const voided = store.voidSale(oldSale.id, admin.id, 'Refunded after the fact');
    assert.equal(voided.status, 'Voided');
    assert.equal(store.getData().products[0].stock, 50, 'stock restored even though the sale lives in an archive file');
    assert.equal(store.getSale(oldSale.id).status, 'Voided', 'the archive file itself was updated, not a throwaway copy');
    assert.throws(() => store.voidSale(oldSale.id, admin.id, 'again'), /already been voided/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('dashboard and salesReport correctly include archived years for a custom range that reaches into them', () => {
  const { store, folder, admin, databasePath } = authenticatedStore();
  try {
    const nails = store.createProduct({ name: 'Nails', category: 'Hardware', price: 45, stock: 100, lowStockThreshold: 5 });
    const oldSale = store.completeSale([{ productId: nails.id, quantity: 2 }], admin.id);
    backdate(databasePath, oldSale.id, '2021-06-15T00:00:00.000Z');
    store.archiveSalesBefore('2022-01-01T00:00:00.000Z');
    assert.equal(store.getData().sales.length, 0);

    const dash = store.dashboard({ type: 'custom', start: '2021-01-01', end: '2021-12-31' });
    assert.equal(dash.summary.transactionCount, 1);
    assert.equal(dash.summary.totalSales, 90);

    const report = store.salesReport({ type: 'custom', start: '2021-01-01', end: '2021-12-31' });
    assert.equal(report.summary.transactionCount, 1);
    assert.equal(report.byProduct[0].productId, nails.id);

    // A recent-period request must not be affected by (or need to read) archives at all.
    const thisWeek = store.dashboard('this-week');
    assert.equal(thisWeek.summary.transactionCount, 0);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('archiveSalesBefore rejects an invalid cutoff date', () => {
  const { store, folder } = authenticatedStore();
  try {
    assert.throws(() => store.archiveSalesBefore('not-a-date'), /valid cutoff date/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
