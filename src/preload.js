const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets only these intentional actions; it never reads the file system directly.
contextBridge.exposeInMainWorld('kjStore', {
  login: (username, password) => ipcRenderer.invoke('auth:login', username, password),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getSession: () => ipcRenderer.invoke('auth:session'),

  getData: () => ipcRenderer.invoke('store:data'),
  getCategories: () => ipcRenderer.invoke('store:categories'),
  getUnits: () => ipcRenderer.invoke('store:units'),
  createProduct: (product) => ipcRenderer.invoke('product:create', product),
  updateProduct: (id, product) => ipcRenderer.invoke('product:update', id, product),
  archiveProduct: (id) => ipcRenderer.invoke('product:archive', id),
  completeSale: (items, discount) => ipcRenderer.invoke('sale:complete', items, discount),
  listSales: (filters) => ipcRenderer.invoke('sale:list', filters),
  getSale: (id) => ipcRenderer.invoke('sale:get', id),
  printReceipt: (saleId, paperWidth, printerChoice) => ipcRenderer.invoke('sale:print-receipt', saleId, paperWidth, printerChoice),
  listPrinters: () => ipcRenderer.invoke('printers:list'),
  getReceiptPreview: (saleId, paperWidth) => ipcRenderer.invoke('sale:receipt-preview', saleId, paperWidth),
  voidSale: (saleId, reason) => ipcRenderer.invoke('sale:void', saleId, reason),
  getArchiveSummary: () => ipcRenderer.invoke('archive:summary'),
  archiveSalesBefore: (cutoffDate) => ipcRenderer.invoke('archive:run', cutoffDate),
  getDashboard: (period) => ipcRenderer.invoke('dashboard:get', period),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (input) => ipcRenderer.invoke('settings:update', input),

  exportInventory: (filters) => ipcRenderer.invoke('export:inventory', filters),
  chooseImportFile: () => ipcRenderer.invoke('import:choose-file'),
  previewImport: (text) => ipcRenderer.invoke('import:preview', text),
  commitImport: (text, duplicateStrategy) => ipcRenderer.invoke('import:commit', text, duplicateStrategy),

  getUserNames: () => ipcRenderer.invoke('user:names'),
  listUsers: () => ipcRenderer.invoke('user:list'),
  createUser: (user) => ipcRenderer.invoke('user:create', user),
  updateUser: (id, user) => ipcRenderer.invoke('user:update', id, user),
  getAuditLog: (filters) => ipcRenderer.invoke('audit:list', filters)
});
