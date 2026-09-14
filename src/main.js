const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { createStore, StoreError } = require('./store');
const { toCsv, toSectionedCsv } = require('./csv');
const { buildReceiptHtml } = require('./receipt');

let store;
let mainWindow;
// Guards against a user mashing "Print Receipt" and spawning several
// concurrent hidden print windows.
let printInProgress = false;

// The authenticated session lives only here, in the main process. The renderer
// never sees more than the public user object returned by auth:session/auth:login.
let currentUser = null;

// Keeps the desktop app reliable on Windows machines with unavailable GPU drivers.
app.disableHardwareAcceleration();

function handle(channel, action) {
  ipcMain.handle(channel, async (_event, ...args) => action(...args));
}

// Re-checks the session against the store on every privileged call, so a user
// deactivated mid-session (or whose role changed) loses access immediately
// rather than only the next time they log in.
function requireAuth() {
  if (!currentUser) throw new StoreError('Please sign in to continue.');
  const fresh = store.getUser(currentUser.id);
  if (!fresh || !fresh.active) {
    currentUser = null;
    store.clearSession();
    throw new StoreError('Your session is no longer active. Please sign in again.');
  }
  currentUser = fresh;
  return currentUser;
}

function requireRole(role) {
  const user = requireAuth();
  if (user.role !== role) throw new StoreError('You do not have permission to do that.');
  return user;
}

// ---- CSV export/import helpers ----

function userDisplayName(userId) {
  if (!userId) return 'Unknown user';
  const user = store.getUser(userId);
  return user ? user.name : 'Deactivated user';
}
const SALE_COLUMNS = [
  { label: 'Transaction ID', value: (sale) => sale.id },
  { label: 'Date', value: (sale) => sale.createdAt },
  { label: 'Processed By', value: (sale) => userDisplayName(sale.userId) },
  { label: 'Items', value: (sale) => sale.itemCount },
  { label: 'Total', value: (sale) => sale.total },
  { label: 'Status', value: (sale) => sale.status }
];
const SALE_ITEM_COLUMNS = [
  { label: 'Transaction ID', value: (row) => row.saleId },
  { label: 'Date', value: (row) => row.createdAt },
  { label: 'Product', value: (row) => row.productName },
  { label: 'SKU', value: (row) => row.sku },
  { label: 'Category', value: (row) => row.category },
  { label: 'Unit', value: (row) => row.unit },
  { label: 'Quantity', value: (row) => row.quantity },
  { label: 'Unit Price', value: (row) => row.unitPrice },
  { label: 'Subtotal', value: (row) => row.subtotal },
  { label: 'Processed By', value: (row) => userDisplayName(row.userId) }
];
function inventoryColumns(includeCost) {
  const columns = [
    { label: 'Product Name', value: (product) => product.name },
    { label: 'SKU', value: (product) => product.sku },
    { label: 'Category', value: (product) => product.category },
    { label: 'Stock Quantity', value: (product) => product.stock },
    { label: 'Unit', value: (product) => product.unit }
  ];
  if (includeCost) columns.push({ label: 'Cost Price', value: (product) => product.costPrice });
  columns.push(
    { label: 'Selling Price', value: (product) => product.price },
    { label: 'Stock Value', value: (product) => Number((product.stock * product.price).toFixed(2)) }
  );
  return columns;
}
function buildSalesReportSections(report) {
  return [
    { title: 'Sales Report Summary', columns: [
      { label: 'Total Sales', value: (row) => row.totalSales }, { label: 'Transactions', value: (row) => row.transactionCount },
      { label: 'Items Sold', value: (row) => row.itemsSold }, { label: 'Average Transaction Value', value: (row) => row.averageTransactionValue }
    ], rows: [report.summary] },
    { title: 'Sales by Date', columns: [
      { label: 'Date', value: (row) => row.date }, { label: 'Total Sales', value: (row) => row.totalSales },
      { label: 'Transactions', value: (row) => row.transactionCount }, { label: 'Items Sold', value: (row) => row.itemsSold }
    ], rows: report.byDate },
    { title: 'Sales by Product', columns: [
      { label: 'Product', value: (row) => row.productName }, { label: 'SKU', value: (row) => row.sku },
      { label: 'Quantity Sold', value: (row) => row.quantitySold }, { label: 'Total Sales', value: (row) => row.totalSales }
    ], rows: report.byProduct },
    { title: 'Sales by Category', columns: [
      { label: 'Category', value: (row) => row.category }, { label: 'Quantity Sold', value: (row) => row.quantitySold }, { label: 'Total Sales', value: (row) => row.totalSales }
    ], rows: report.byCategory },
    { title: 'Sales by User', columns: [
      { label: 'User', value: (row) => row.userName }, { label: 'Transactions', value: (row) => row.transactionCount },
      { label: 'Items Sold', value: (row) => row.itemsSold }, { label: 'Total Sales', value: (row) => row.totalSales }
    ], rows: report.byUser }
  ];
}
function buildInventoryReportSections(report, includeCost) {
  const summaryColumns = [
    { label: 'Total Products', value: (row) => row.totalProducts }, { label: 'Low Stock', value: (row) => row.lowStockCount },
    { label: 'Out of Stock', value: (row) => row.outOfStockCount }, { label: 'Inventory Value (Retail)', value: (row) => row.inventoryValueAtRetail }
  ];
  if (includeCost) summaryColumns.push({ label: 'Inventory Value (Cost)', value: (row) => row.inventoryValueAtCost });
  const categoryColumns = [
    { label: 'Category', value: (row) => row.category }, { label: 'Products', value: (row) => row.productCount }, { label: 'Value (Retail)', value: (row) => row.valueAtRetail }
  ];
  if (includeCost) categoryColumns.push({ label: 'Value (Cost)', value: (row) => row.valueAtCost });
  return [
    { title: 'Inventory Report Summary', columns: summaryColumns, rows: [report.summary] },
    { title: 'Low Stock Products', columns: inventoryColumns(includeCost), rows: report.lowStock },
    { title: 'Out of Stock Products', columns: inventoryColumns(includeCost), rows: report.outOfStock },
    { title: 'By Category', columns: categoryColumns, rows: report.byCategory }
  ];
}
// Regular users can view/export the inventory report, but cost-price-derived
// figures (margin-sensitive) are stripped for anyone who isn't a Super Admin.
function stripInventoryReportCost(report, role) {
  if (role === 'super-admin') return report;
  const { inventoryValueAtCost, ...summary } = report.summary;
  return {
    summary,
    byCategory: report.byCategory.map(({ valueAtCost, ...rest }) => rest),
    lowStock: report.lowStock.map(({ costPrice, ...rest }) => rest),
    outOfStock: report.outOfStock.map(({ costPrice, ...rest }) => rest)
  };
}
function datedFilename(base) { return `${base}_${new Date().toISOString().slice(0, 10)}.csv`; }
async function exportCsv(defaultFileName, csvContent) {
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultFileName, filters: [{ name: 'CSV files', extensions: ['csv'] }] });
  if (result.canceled || !result.filePath) return { saved: false };
  fs.writeFileSync(result.filePath, csvContent, 'utf8');
  return { saved: true, path: result.filePath };
}

// Electron flow: sale ID -> look up sale/items -> build receipt HTML -> load
// it into a hidden, throwaway BrowserWindow -> wait for load -> trigger the
// OS's native print dialog -> close the window once printing is done.
async function printSaleReceipt(saleId, paperWidth) {
  if (!saleId || typeof saleId !== 'string') throw new StoreError('A valid sale is required to print a receipt.');
  if (printInProgress) throw new StoreError('A receipt is already printing. Please wait for it to finish.');
  const sale = store.getSale(saleId);
  if (!sale) throw new StoreError('That transaction could not be found.');

  printInProgress = true;
  let printWindow;
  try {
    const html = buildReceiptHtml(sale, { paperWidth, processedByName: userDisplayName(sale.userId) });
    printWindow = new BrowserWindow({
      show: false,
      parent: mainWindow,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const result = await new Promise((resolve) => {
      printWindow.webContents.print({ silent: false, printBackground: true }, (success, failureErrorType) => {
        resolve({ printed: success, cancelled: !success && failureErrorType === 'cancelled', reason: success ? null : failureErrorType });
      });
    });
    return result;
  } finally {
    if (printWindow && !printWindow.isDestroyed()) printWindow.close();
    printInProgress = false;
  }
}

function registerStoreHandlers() {
  handle('auth:login', (username, password) => {
    const user = store.authenticate(username, password);
    currentUser = user;
    return user;
  });
  handle('auth:logout', () => {
    currentUser = null;
    store.clearSession();
    return true;
  });
  handle('auth:session', () => {
    currentUser = store.getSession();
    return currentUser;
  });

  handle('store:data', () => { requireAuth(); return store.getData(); });
  handle('store:categories', () => { requireAuth(); return store.CATEGORIES; });
  handle('store:units', () => { requireAuth(); return store.UNITS; });
  handle('product:create', (product) => { requireAuth(); return store.createProduct(product); });
  handle('product:update', (id, product) => { requireAuth(); return store.updateProduct(id, product); });
  handle('product:archive', (id) => { requireAuth(); return store.archiveProduct(id); });
  // The processing user always comes from the authenticated session, never from
  // renderer-supplied input, so a sale can't be attributed to someone else.
  handle('sale:complete', (items) => { const user = requireAuth(); return store.completeSale(items, user.id); });
  handle('sale:list', (filters) => { requireAuth(); return store.listSales(filters); });
  handle('sale:get', (id) => { requireAuth(); return store.getSale(id); });
  handle('sale:print-receipt', (saleId, paperWidth) => { requireAuth(); return printSaleReceipt(saleId, paperWidth); });
  handle('sale:void', (saleId, reason) => { const user = requireRole('super-admin'); return store.voidSale(saleId, user.id, reason); });
  handle('archive:summary', () => { requireRole('super-admin'); return store.archiveSummary(); });
  handle('archive:run', (cutoffDate) => { requireRole('super-admin'); return store.archiveSalesBefore(cutoffDate); });
  handle('dashboard:get', (period) => { requireAuth(); return store.dashboard(period); });

  // Minimal, non-privileged lookup so any signed-in user can resolve "Processed
  // By" names in History without exposing email, role, or status to non-admins.
  handle('user:names', () => { requireAuth(); return store.listUsers().map(({ id, name }) => ({ id, name })); });

  handle('user:list', () => { requireRole('super-admin'); return store.listUsers(); });
  handle('user:create', (user) => { requireRole('super-admin'); return store.createUser(user); });
  handle('user:update', (id, user) => { requireRole('super-admin'); return store.updateUser(id, user); });

  handle('report:sales', (filter) => { requireAuth(); return store.salesReport(filter); });
  handle('report:inventory', () => { const user = requireAuth(); return stripInventoryReportCost(store.inventoryReport(), user.role); });

  handle('export:sales', async (filters) => { requireAuth(); const rows = store.listSales(filters); return exportCsv(datedFilename('Sales'), toCsv(SALE_COLUMNS, rows)); });
  handle('export:sale-items', async (filters) => {
    requireAuth();
    const rows = store.listSales(filters).flatMap((sale) => sale.items.map((item) => ({ ...item, saleId: sale.id, createdAt: sale.createdAt, userId: sale.userId })));
    return exportCsv(datedFilename('Sale_Items'), toCsv(SALE_ITEM_COLUMNS, rows));
  });
  handle('export:inventory', async (filters) => { const user = requireAuth(); const rows = store.listProducts(filters); return exportCsv(datedFilename('Inventory'), toCsv(inventoryColumns(user.role === 'super-admin'), rows)); });
  handle('export:sales-report', async (filter) => { requireAuth(); const report = store.salesReport(filter); return exportCsv(datedFilename('Sales_Report'), toSectionedCsv(buildSalesReportSections(report))); });
  handle('export:inventory-report', async () => {
    const user = requireAuth();
    const report = stripInventoryReportCost(store.inventoryReport(), user.role);
    return exportCsv(datedFilename('Inventory_Report'), toSectionedCsv(buildInventoryReportSections(report, user.role === 'super-admin')));
  });

  handle('import:choose-file', async () => {
    requireRole('super-admin');
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'CSV files', extensions: ['csv'] }] });
    if (result.canceled || !result.filePaths.length) return null;
    const filePath = result.filePaths[0];
    return { fileName: path.basename(filePath), text: fs.readFileSync(filePath, 'utf8') };
  });
  handle('import:preview', (text) => { requireRole('super-admin'); return store.previewImport(text); });
  handle('import:commit', (text, duplicateStrategy) => { requireRole('super-admin'); return store.commitImport(text, duplicateStrategy); });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: '#f6f8fb',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  store = createStore(path.join(app.getPath('userData'), 'kj-store-data.json'));
  store.initialize();
  // Demo/sample products and sales are intentionally NOT auto-seeded here.
  // A fresh install starts completely empty except for the default Super
  // Admin account created by initialize(). (store.seedDemoData() still
  // exists and is covered by tests, for anyone who wants a quick way to
  // populate a throwaway dev/demo database.)
  currentUser = store.getSession();
  registerStoreHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
