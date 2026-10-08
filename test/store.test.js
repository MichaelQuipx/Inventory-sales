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
    const product = store.createProduct({ name: 'Galvanized Nails', sku: 'HW-001', category: 'Hardware', price: 45.5, costPrice: 30, stock: 10, lowStockThreshold: 3 });
    assert.equal(store.getData().products.length, 1);
    const sale = store.completeSale([{ productId: product.id, quantity: 3 }], admin.id);
    assert.equal(sale.total, 136.5);
    assert.equal(sale.itemCount, 3);
    assert.equal(sale.userId, admin.id);
    assert.equal(sale.items[0].costPrice, 30);
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
    // Profit = (45.5 - 30) * 4 units sold = 62
    assert.equal(dashboard.summary.totalProfit, 62);
    assert.equal(dashboard.summary.profitMargin, Number((62 / 182 * 100).toFixed(1)));
    assert.equal(dashboard.graph.reduce((sum, point) => sum + point.total, 0), 182);
    assert.equal(dashboard.graph.reduce((sum, point) => sum + point.profit, 0), 62);
    for (const period of ['daily', 'weekly', 'monthly', 'yearly']) {
      const graph = store.dashboard(period).graph;
      assert.ok(graph.length > 0);
      assert.equal(graph.reduce((sum, point) => sum + point.total, 0), 182);
      assert.equal(graph.reduce((sum, point) => sum + point.profit, 0), 62);
      assert.ok(graph.every((point) => point.tooltip));
    }
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('sale profit is snapshotted at sale time and unaffected by later cost-price changes', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const product = store.createProduct({ name: 'Engine Oil 1L', category: 'Motorparts', price: 320, costPrice: 250, stock: 10, lowStockThreshold: 2 });
    store.completeSale([{ productId: product.id, quantity: 2 }], admin.id);
    assert.equal(store.dashboard('daily').summary.totalProfit, 140); // (320-250)*2
    store.updateProduct(product.id, { name: product.name, category: product.category, price: 320, costPrice: 300, stock: 8, lowStockThreshold: 2 });
    // The already-completed sale's profit stays computed off the cost price at
    // the time it was sold, not the product's new cost price.
    assert.equal(store.dashboard('daily').summary.totalProfit, 140);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('a sale recorded before cost price existed falls back to the product\'s current cost price', () => {
  const { store, folder, databasePath, admin } = authenticatedStore();
  try {
    const product = store.createProduct({ name: 'Spark Plug', category: 'Motorparts', price: 145, costPrice: 90, stock: 10, lowStockThreshold: 2 });
    store.completeSale([{ productId: product.id, quantity: 2 }], admin.id);
    // Simulate a legacy sale item saved before costPrice was ever captured.
    const raw = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
    delete raw.sales[0].items[0].costPrice;
    fs.writeFileSync(databasePath, JSON.stringify(raw), 'utf8');
    assert.equal(store.dashboard('daily').summary.totalProfit, (145 - 90) * 2);
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

// ---- Sale discounts ----

test('completeSale applies a discount, recording subtotal, discount, and the final total', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const nails = store.createProduct({ name: 'Nails', category: 'Hardware', price: 50, stock: 20, lowStockThreshold: 2 });
    const sale = store.completeSale([{ productId: nails.id, quantity: 3 }], admin.id, 20);
    assert.equal(sale.subtotal, 150);
    assert.equal(sale.discount, 20);
    assert.equal(sale.total, 130);
    assert.equal(store.getSale(sale.id).total, 130);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('completeSale defaults to no discount when none is given, and treats it as zero', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const nails = store.createProduct({ name: 'Nails', category: 'Hardware', price: 50, stock: 20, lowStockThreshold: 2 });
    const sale = store.completeSale([{ productId: nails.id, quantity: 2 }], admin.id);
    assert.equal(sale.subtotal, 100);
    assert.equal(sale.discount, 0);
    assert.equal(sale.total, 100);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('completeSale rejects a negative discount and a discount larger than the subtotal', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const nails = store.createProduct({ name: 'Nails', category: 'Hardware', price: 50, stock: 20, lowStockThreshold: 2 });
    assert.throws(() => store.completeSale([{ productId: nails.id, quantity: 1 }], admin.id, -5), /Discount must be zero or greater/);
    assert.throws(() => store.completeSale([{ productId: nails.id, quantity: 1 }], admin.id, 100), /Discount cannot be greater than the subtotal/);
    // A discount exactly equal to the subtotal (free item) is allowed.
    const freeSale = store.completeSale([{ productId: nails.id, quantity: 1 }], admin.id, 50);
    assert.equal(freeSale.total, 0);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('a discounted sale reports its final (discounted) total in dashboard and salesReport totals', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const nails = store.createProduct({ name: 'Nails', category: 'Hardware', price: 50, stock: 20, lowStockThreshold: 2 });
    store.completeSale([{ productId: nails.id, quantity: 2 }], admin.id, 15);
    const dashboard = store.dashboard('this-week');
    assert.equal(dashboard.summary.totalSales, 85);
    const report = store.salesReport('this-week');
    assert.equal(report.summary.totalSales, 85);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('receipt paper width defaults to 80mm and can be saved as the default setting', () => {
  const { store, folder } = authenticatedStore();
  try {
    assert.deepEqual(store.getSettings(), { receiptPaperWidth: '80mm', maxRegularUserDiscountPercent: 20, receiptTopMarginLines: 1, receiptBottomMarginLines: 5, receiptLeftMarginChars: 0, receiptMinLines: 20 });
    const updated = store.updateSettings({ receiptPaperWidth: '58mm' });
    assert.equal(updated.receiptPaperWidth, '58mm');
    // Persists across reads, like the rest of the database.
    assert.equal(store.getSettings().receiptPaperWidth, '58mm');
    assert.throws(() => store.updateSettings({ receiptPaperWidth: '110mm' }), /Paper width must be 58mm or 80mm/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('centimeter and meter are available as fractional (divisible) units', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const wire = store.createProduct({ name: 'Electrical Wire', category: 'Hardware', unit: 'm', price: 25, stock: 100, lowStockThreshold: 10 });
    assert.equal(wire.unit, 'm');
    const sale = store.completeSale([{ productId: wire.id, quantity: 2.5 }], admin.id);
    assert.equal(sale.total, 62.5);
    assert.equal(store.getData().products[0].stock, 97.5);

    const rope = store.createProduct({ name: 'Nylon Rope', category: 'Hardware', unit: 'cm', price: 2, stock: 500, lowStockThreshold: 50 });
    assert.equal(rope.unit, 'cm');
    store.completeSale([{ productId: rope.id, quantity: 37.5 }], admin.id);
    assert.equal(store.getData().products[1].stock, 462.5);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('"load" is a fractional unit, so full/half/quarter dump-truck loads are all just quantities of the same unit', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const sand = store.createProduct({ name: 'Sand', category: 'Hardware', unit: 'load', price: 4000, costPrice: 2500, stock: 10, lowStockThreshold: 1 });
    assert.equal(sand.unit, 'load');

    // 1 Full Load
    const fullLoad = store.completeSale([{ productId: sand.id, quantity: 1 }], admin.id);
    assert.equal(fullLoad.total, 4000);
    assert.equal(store.getData().products[0].stock, 9);

    // 1/2 Load
    const halfLoad = store.completeSale([{ productId: sand.id, quantity: 0.5 }], admin.id);
    assert.equal(halfLoad.total, 2000);
    assert.equal(store.getData().products[0].stock, 8.5);

    // 2 Half Loads in one sale == 1 full load's worth
    const twoHalfLoads = store.completeSale([{ productId: sand.id, quantity: 0.5 }, { productId: sand.id, quantity: 0.5 }], admin.id);
    assert.equal(twoHalfLoads.total, 4000);
    assert.equal(store.getData().products[0].stock, 7.5);

    // Other units (piece, kg, sack, ...) keep working normally alongside "load".
    const nails = store.createProduct({ name: 'Nails', category: 'Hardware', unit: 'kg', price: 60, stock: 20, lowStockThreshold: 2 });
    store.completeSale([{ productId: nails.id, quantity: 1.5 }], admin.id);
    assert.equal(store.getData().products.find((p) => p.id === nails.id).stock, 18.5);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('a Regular User\'s discount is capped by the configurable Settings limit; a Super Admin is unlimited', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const cashier = store.createUser({ name: 'Cashier One', username: 'cashier1', password: 'Password123', role: 'regular-user' });
    const rice = store.createProduct({ name: 'Jasmine Rice', category: 'Rice', price: 100, costPrice: 80, stock: 100, lowStockThreshold: 5 });

    // Default cap is 20%: a 100 subtotal allows at most a 20 discount.
    assert.throws(
      () => store.completeSale([{ productId: rice.id, quantity: 1 }], cashier.id, 25),
      /Discount cannot exceed 20%/
    );
    const withinCap = store.completeSale([{ productId: rice.id, quantity: 1 }], cashier.id, 20);
    assert.equal(withinCap.total, 80);

    // A Super Admin is not subject to the cap.
    const adminSale = store.completeSale([{ productId: rice.id, quantity: 1 }], admin.id, 90);
    assert.equal(adminSale.total, 10);

    // The cap itself is adjustable (e.g. by a Super Admin via Settings).
    store.updateSettings({ maxRegularUserDiscountPercent: 50 });
    const raised = store.completeSale([{ productId: rice.id, quantity: 1 }], cashier.id, 50);
    assert.equal(raised.total, 50);
    assert.throws(() => store.completeSale([{ productId: rice.id, quantity: 1 }], cashier.id, 51), /Discount cannot exceed 50%/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('a product\'s price/cost/stock changes are recorded in the audit log with old and new values', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const rice = store.createProduct({ name: 'Jasmine Rice', category: 'Rice', price: 100, costPrice: 80, stock: 50, lowStockThreshold: 5 });
    store.updateProduct(rice.id, { name: 'Jasmine Rice', category: 'Rice', price: 120, costPrice: 80, stock: 50, lowStockThreshold: 5 }, admin.id);

    const log = store.listAuditLog();
    const priceChange = log.find((entry) => entry.action === 'Selling price changed');
    assert.ok(priceChange, 'expected a "Selling price changed" audit entry');
    assert.equal(priceChange.before, 100);
    assert.equal(priceChange.after, 120);
    assert.equal(priceChange.userId, admin.id);
    assert.ok(priceChange.target.includes('Jasmine Rice'));

    // Editing something unrelated to price/cost/stock shouldn't add noise.
    const beforeCount = store.listAuditLog().length;
    store.updateProduct(rice.id, { name: 'Jasmine Rice Premium', category: 'Rice', price: 120, costPrice: 80, stock: 50, lowStockThreshold: 5 }, admin.id);
    assert.equal(store.listAuditLog().length, beforeCount);

    store.archiveProduct(rice.id, admin.id);
    assert.ok(store.listAuditLog().some((entry) => entry.action === 'Product archived' && entry.userId === admin.id));
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('completed sales, discounts, and voids are all recorded in the audit log', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const rice = store.createProduct({ name: 'Jasmine Rice', category: 'Rice', price: 100, costPrice: 80, stock: 50, lowStockThreshold: 5 });
    const sale = store.completeSale([{ productId: rice.id, quantity: 1 }], admin.id, 10);
    assert.ok(store.listAuditLog().some((entry) => entry.action === 'Sale completed' && entry.target === sale.id));
    assert.ok(store.listAuditLog().some((entry) => entry.action === 'Discount applied' && entry.target === sale.id && entry.after === 10));

    store.voidSale(sale.id, admin.id, 'Customer changed their mind');
    assert.ok(store.listAuditLog().some((entry) => entry.action === 'Sale voided' && entry.target === sale.id));
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('user creation and role changes are recorded in the audit log', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const cashier = store.createUser({ name: 'Cashier One', username: 'cashier1', password: 'Password123', role: 'regular-user' }, admin.id);
    assert.ok(store.listAuditLog().some((entry) => entry.action === 'User created' && entry.userId === admin.id));

    store.updateUser(cashier.id, { name: cashier.name, username: cashier.username, role: 'super-admin', active: true }, admin.id);
    const roleChange = store.listAuditLog().find((entry) => entry.action === 'User role changed');
    assert.ok(roleChange);
    assert.equal(roleChange.before, 'regular-user');
    assert.equal(roleChange.after, 'super-admin');
    assert.equal(roleChange.userId, admin.id);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('a sale always uses the product\'s current authoritative price, never a price supplied by the caller', () => {
  const { store, folder, admin } = authenticatedStore();
  try {
    const rice = store.createProduct({ name: 'Jasmine Rice', category: 'Rice', price: 100, costPrice: 80, stock: 50, lowStockThreshold: 5 });
    // Simulates a tampered renderer trying to smuggle its own price/subtotal.
    const sale = store.completeSale([{ productId: rice.id, quantity: 2, price: 1, unitPrice: 1, subtotal: 2 }], admin.id);
    assert.equal(sale.items[0].unitPrice, 100);
    assert.equal(sale.total, 200);

    // Changing the price afterward never rewrites the already-completed sale
    // (the "change price, sell, change it back" loophole).
    store.updateProduct(rice.id, { name: 'Jasmine Rice', category: 'Rice', price: 50, costPrice: 80, stock: 48, lowStockThreshold: 5 }, admin.id);
    assert.equal(store.getSale(sale.id).items[0].unitPrice, 100);
    assert.equal(store.getSale(sale.id).total, 200);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('the preferred receipt printer name can be saved as a setting', () => {
  const { store, folder } = authenticatedStore();
  try {
    assert.equal(store.updateSettings({ receiptPrinterName: '  POS-58  ' }).receiptPrinterName, 'POS-58');
    assert.equal(store.getSettings().receiptPrinterName, 'POS-58');
    assert.throws(() => store.updateSettings({ receiptPrinterName: 'x'.repeat(201) }), /too long/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('receipt margins and minimum length are saved as settings, within limits', () => {
  const { store, folder } = authenticatedStore();
  try {
    const saved = store.updateSettings({ receiptTopMarginLines: 2, receiptBottomMarginLines: 8, receiptMinLines: 30 });
    assert.equal(saved.receiptBottomMarginLines, 8);
    assert.equal(store.getSettings().receiptMinLines, 30);
    assert.throws(() => store.updateSettings({ receiptBottomMarginLines: 99 }), /Bottom margin must be a whole number/);
    assert.throws(() => store.updateSettings({ receiptTopMarginLines: -1 }), /Top margin/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
