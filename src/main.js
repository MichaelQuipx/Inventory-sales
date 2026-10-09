const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { createStore, StoreError } = require('./store');
const { toCsv, toSectionedCsv } = require('./csv');
const { buildReceiptHtml, PAPER_WIDTH_MM } = require('./receipt');
const { looksLikeThermalPrinter, pickPrinter } = require('./printers');

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
  { label: 'Subtotal', value: (sale) => sale.subtotal ?? sale.total },
  { label: 'Discount', value: (sale) => sale.discount ?? 0 },
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
// Inventory (including cost price) is now full access for all users, so no
// role-based stripping is needed here (unlike the Dashboard's profit
// figures, which stay Super-Admin-only since Dashboard itself is restricted).
// Profit is derived from cost price, so it's stripped from the dashboard for
// anyone who isn't a Super Admin -- same rule as the inventory report/exports.
function stripDashboardProfit(dashboard, role) {
  if (role === 'super-admin') return dashboard;
  const { totalProfit, profitMargin, ...summary } = dashboard.summary;
  return { ...dashboard, summary, graph: dashboard.graph.map(({ profit, ...rest }) => rest) };
}
function datedFilename(base) { return `${base}_${new Date().toISOString().slice(0, 10)}.csv`; }
async function exportCsv(defaultFileName, csvContent) {
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultFileName, filters: [{ name: 'CSV files', extensions: ['csv'] }] });
  if (result.canceled || !result.filePath) return { saved: false };
  fs.writeFileSync(result.filePath, csvContent, 'utf8');
  return { saved: true, path: result.filePath };
}

// Returns the exact same HTML that would be sent to the printer, so the
// in-app preview is a true WYSIWYG of the printed receipt -- one receipt
// template, never two implementations to keep in sync.
function buildReceiptPreview(saleId) {
  if (!saleId || typeof saleId !== 'string') throw new StoreError('A valid sale is required to preview a receipt.');
  const sale = store.getSale(saleId);
  if (!sale) throw new StoreError('That transaction could not be found.');
  return buildReceiptHtml(sale, { processedByName: userDisplayName(sale.userId), layout: receiptLayout(store.getSettings()) });
}

// ---- Receipt printing ----
//
// Root cause of the old "Printing..." hang: the receipt was sent through a
// hidden window with silent:false. That asks Windows to show its print dialog
// on behalf of a window nobody can see, so the dialog never appeared, Electron
// never invoked the print callback, and the promise (and the button) waited
// forever. Now we (1) detect installed printers, (2) print silently straight to
// the chosen one, (3) always time out, and (4) report a real error message.
// Per-install print preferences any signed-in user may change.
const HARMLESS_SETTINGS = ['receiptPrinterName', 'receiptTopMarginLines', 'receiptBottomMarginLines', 'receiptLeftMarginChars', 'receiptMinLines'];
function receiptLayout(settings) {
  return { topMarginLines: settings.receiptTopMarginLines, bottomMarginLines: settings.receiptBottomMarginLines, leftMarginChars: settings.receiptLeftMarginChars, minLines: settings.receiptMinLines };
}
const PRINT_TIMEOUT_MS = 30000;
const DIALOG_PRINT_TIMEOUT_MS = 180000;
const PRINT_DIALOG_CHOICE = '__system-dialog__';
const MICRONS_PER_PIXEL = 264.5833; // CSS px at 96dpi
const PRINT_FAILURE_MESSAGES = {
  cancelled: 'Printing was cancelled.',
  failed: 'The printer rejected the job. Check that it is powered on, has paper, and is not paused or offline in Windows.',
  'invalid printer settings': 'Windows reported invalid printer settings for this printer.'
};

async function listPrinters() {
  const printers = await mainWindow.webContents.getPrintersAsync();
  return printers.map((printer) => ({
    name: printer.name,
    displayName: printer.displayName || printer.name,
    isDefault: Boolean(printer.isDefault),
    looksThermal: looksLikeThermalPrinter(printer)
  }));
}

async function getPrinterChoices() {
  const printers = await listPrinters();
  const saved = store.getSettings().receiptPrinterName;
  const selected = saved === PRINT_DIALOG_CHOICE ? null : pickPrinter(printers, saved);
  return { printers, selected: saved === PRINT_DIALOG_CHOICE ? PRINT_DIALOG_CHOICE : (selected ? selected.name : '') };
}

function sendToPrinter(webContents, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new StoreError('The printer did not respond. Make sure it is turned on, connected, and not offline, then try again.')), timeoutMs);
    try {
      webContents.print(options, (success, failureType) => {
        clearTimeout(timer);
        resolve({ success, failureType });
      });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}

async function printSaleReceipt(saleId, printerChoice) {
  if (!saleId || typeof saleId !== 'string') throw new StoreError('A valid sale is required to print a receipt.');
  if (printInProgress) throw new StoreError('A receipt is already printing. Please wait for it to finish.');
  const sale = store.getSale(saleId);
  if (!sale) throw new StoreError('That transaction could not be found.');
  const widthMm = PAPER_WIDTH_MM;

  const useDialog = printerChoice === PRINT_DIALOG_CHOICE;
  let printerName = null;
  if (!useDialog) {
    const printers = await listPrinters();
    if (!printers.length) throw new StoreError('No printers were found on this computer. Install the thermal printer in Windows (Settings > Printers & scanners) and try again.');
    const chosen = pickPrinter(printers, printerChoice);
    // A saved name that no longer exists (printer removed/renamed) falls back
    // to auto-detection instead of failing the sale receipt.
    printerName = chosen.name;
  }

  printInProgress = true;
  let printWindow;
  try {
    const html = buildReceiptHtml(sale, { processedByName: userDisplayName(sale.userId), layout: receiptLayout(store.getSettings()) });
    printWindow = new BrowserWindow({
      show: false,
      width: Math.ceil(widthMm * 3.78) + 60,
      height: 800,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    if (useDialog) {
      const result = await sendToPrinter(printWindow.webContents, { silent: false, printBackground: true }, DIALOG_PRINT_TIMEOUT_MS);
      return { printed: result.success, cancelled: !result.success && result.failureType === 'cancelled', reason: result.success ? null : (PRINT_FAILURE_MESSAGES[result.failureType] || result.failureType), printer: null };
    }

    // Exact receipt length (instead of a fixed page) so the thermal printer
    // feeds just the receipt, not a metre of blank paper.
    const contentHeightPx = await printWindow.webContents.executeJavaScript('Math.ceil(document.body.getBoundingClientRect().height)');
    const heightMicrons = Math.max(30000, Math.round(contentHeightPx * MICRONS_PER_PIXEL) + 2000);
    const baseOptions = { silent: true, deviceName: printerName, printBackground: true, margins: { marginType: 'none' } };

    let result = await sendToPrinter(printWindow.webContents, { ...baseOptions, pageSize: { width: widthMm * 1000, height: heightMicrons } }, PRINT_TIMEOUT_MS);
    if (!result.success && result.failureType !== 'cancelled') {
      // Some thermal drivers refuse a custom paper size; retry using the
      // driver's own default paper (the receipt CSS is already 58mm wide).
      result = await sendToPrinter(printWindow.webContents, baseOptions, PRINT_TIMEOUT_MS);
    }
    return {
      printed: result.success,
      cancelled: !result.success && result.failureType === 'cancelled',
      reason: result.success ? null : (PRINT_FAILURE_MESSAGES[result.failureType] || result.failureType || 'Unknown printer error.'),
      printer: printerName
    };
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
  // Regular Users can add/edit/archive products directly (price, stock,
  // etc. -- see the client's latest decision). Cost price stays hidden from
  // them in the UI/exports, and every change is still recorded in the audit
  // log with who made it, so this isn't a blind-trust rollback.
  handle('product:create', (product) => { requireAuth(); return store.createProduct(product); });
  handle('product:update', (id, product) => { const user = requireAuth(); return store.updateProduct(id, product, user.id); });
  handle('product:archive', (id) => { const user = requireAuth(); return store.archiveProduct(id, user.id); });
  // The processing user always comes from the authenticated session, never from
  // renderer-supplied input, so a sale can't be attributed to someone else.
  handle('sale:complete', (items, discount) => { const user = requireAuth(); return store.completeSale(items, user.id, discount); });
  handle('sale:list', (filters) => { requireAuth(); return store.listSales(filters); });
  handle('sale:get', (id) => { requireAuth(); return store.getSale(id); });
  handle('sale:print-receipt', (saleId, printerChoice) => { requireAuth(); return printSaleReceipt(saleId, printerChoice); });
  handle('printers:list', () => { requireAuth(); return getPrinterChoices(); });
  handle('sale:receipt-preview', (saleId) => { requireAuth(); return buildReceiptPreview(saleId); });
  handle('sale:void', (saleId, reason) => { const user = requireRole('super-admin'); return store.voidSale(saleId, user.id, reason); });
  handle('archive:summary', () => { requireRole('super-admin'); return store.archiveSummary(); });
  handle('archive:run', (cutoffDate) => { requireRole('super-admin'); return store.archiveSalesBefore(cutoffDate); });
  handle('dashboard:get', (period) => { const user = requireRole('super-admin'); return stripDashboardProfit(store.dashboard(period), user.role); });
  handle('settings:get', () => { requireAuth(); return store.getSettings(); });
  // receiptPrinterName and the receipt margin settings are harmless per-install preferences, open to any
  // signed-in user. Anything else in settings (e.g. the discount cap) is
  // security-relevant, so it's locked to Super Admin -- otherwise a Regular
  // User could simply raise their own discount ceiling.
  handle('settings:update', (input) => {
    const user = requireAuth();
    const sensitiveKeys = Object.keys(input || {}).filter((key) => !HARMLESS_SETTINGS.includes(key));
    if (sensitiveKeys.length && user.role !== 'super-admin') throw new StoreError('You do not have permission to change that setting.');
    return store.updateSettings(input);
  });
  handle('audit:list', (filters) => { requireRole('super-admin'); return store.listAuditLog(filters); });

  // Minimal, non-privileged lookup so any signed-in user can resolve "Processed
  // By" names in History without exposing email, role, or status to non-admins.
  handle('user:names', () => { requireAuth(); return store.listUsers().map(({ id, name }) => ({ id, name })); });

  handle('user:list', () => { requireRole('super-admin'); return store.listUsers(); });
  handle('user:create', (user) => { const admin = requireRole('super-admin'); return store.createUser(user, admin.id); });
  handle('user:update', (id, user) => { const admin = requireRole('super-admin'); return store.updateUser(id, user, admin.id); });

  handle('report:sales', (filter) => { requireAuth(); return store.salesReport(filter); });
  // Full inventory access for all users now: cost/valuation figures are no
  // longer stripped by role.
  handle('report:inventory', () => { requireAuth(); return store.inventoryReport(); });

  handle('export:sales', async (filters) => { requireAuth(); const rows = store.listSales(filters); return exportCsv(datedFilename('Sales'), toCsv(SALE_COLUMNS, rows)); });
  handle('export:sale-items', async (filters) => {
    requireAuth();
    const rows = store.listSales(filters).flatMap((sale) => sale.items.map((item) => ({ ...item, saleId: sale.id, createdAt: sale.createdAt, userId: sale.userId })));
    return exportCsv(datedFilename('Sale_Items'), toCsv(SALE_ITEM_COLUMNS, rows));
  });
  handle('export:inventory', async (filters) => { requireAuth(); const rows = store.listProducts(filters); return exportCsv(datedFilename('Inventory'), toCsv(inventoryColumns(true), rows)); });
  handle('export:sales-report', async (filter) => { requireAuth(); const report = store.salesReport(filter); return exportCsv(datedFilename('Sales_Report'), toSectionedCsv(buildSalesReportSections(report))); });
  handle('export:inventory-report', async () => {
    requireAuth();
    const report = store.inventoryReport();
    return exportCsv(datedFilename('Inventory_Report'), toSectionedCsv(buildInventoryReportSections(report, true)));
  });

  // Bulk CSV import is now open to all users too (full inventory access).
  handle('import:choose-file', async () => {
    requireAuth();
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'CSV files', extensions: ['csv'] }] });
    if (result.canceled || !result.filePaths.length) return null;
    const filePath = result.filePaths[0];
    return { fileName: path.basename(filePath), text: fs.readFileSync(filePath, 'utf8') };
  });
  handle('import:preview', (text) => { requireAuth(); return store.previewImport(text); });
  handle('import:commit', (text, duplicateStrategy) => { requireAuth(); return store.commitImport(text, duplicateStrategy); });
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
      nodeIntegration: false,
      sandbox: true,
      // DevTools access is blocked only in packaged (production) builds, kept
      // available under `npm start` for development. This is a deterrent,
      // not a security boundary: every privileged action is authorized in
      // this main process regardless of whether DevTools can be opened, so
      // closing it off here changes nothing about what's actually protected.
      devTools: !app.isPackaged
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
