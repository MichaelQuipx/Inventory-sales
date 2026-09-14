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
  completeSale: (items) => ipcRenderer.invoke('sale:complete', items),
  listSales: (filters) => ipcRenderer.invoke('sale:list', filters),
  getSale: (id) => ipcRenderer.invoke('sale:get', id),
  printReceipt: (saleId, paperWidth) => ipcRenderer.invoke('sale:print-receipt', saleId, paperWidth),
  voidSale: (saleId, reason) => ipcRenderer.invoke('sale:void', saleId, reason),
  getArchiveSummary: () => ipcRenderer.invoke('archive:summary'),
  archiveSalesBefore: (cutoffDate) => ipcRenderer.invoke('archive:run', cutoffDate),
  getDashboard: (period) => ipcRenderer.invoke('dashboard:get', period),

  exportInventory: (filters) => ipcRenderer.invoke('export:inventory', filters),
  chooseImportFile: () => ipcRenderer.invoke('import:choose-file'),
  previewImport: (text) => ipcRenderer.invoke('import:preview', text),
  commitImport: (text, duplicateStrategy) => ipcRenderer.invoke('import:commit', text, duplicateStrategy),

  getUserNames: () => ipcRenderer.invoke('user:names'),
  listUsers: () => ipcRenderer.invoke('user:list'),
  createUser: (user) => ipcRenderer.invoke('user:create', user),
  updateUser: (id, user) => ipcRenderer.invoke('user:update', id, user)
});
