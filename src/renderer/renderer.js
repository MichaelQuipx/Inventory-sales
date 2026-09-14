const app = document.querySelector('#app');
const modalRoot = document.querySelector('#modal-root');
const toastRoot = document.querySelector('#toast-root');

const state = { page: 'dashboard', products: [], sales: [], cart: [], categories: [], units: [], userNames: [], users: [], currentUser: null, dashboardFilter: { type: 'this-week', start: '', end: '', userId: '' }, inventoryPagination: { page: 1, pageSize: 20 }, historyPagination: { page: 1, pageSize: 20 }, usersPagination: { page: 1, pageSize: 20 } };
const money = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
const dateTime = new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' });

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}
function formatMoney(value) { return money.format(Number(value || 0)); }

// ---- Table row-action icons ----
const TABLE_ICONS = {
  edit: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12.8 3.7l3.5 3.5-9 9H3.8v-3.5z"/><path d="M11.3 5.2l3.5 3.5"/></svg>',
  archive: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3.5" width="14" height="3" rx="1"/><path d="M4.2 6.5v8.3a1 1 0 001 1h9.6a1 1 0 001-1V6.5"/><path d="M8 10h4"/></svg>',
  view: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6z"/><circle cx="10" cy="10" r="2.3"/></svg>',
  printer: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 7V3.3h8V7"/><rect x="3" y="7" width="14" height="6.6" rx="1.1"/><path d="M6.3 12.6h7.4v4H6.3z"/></svg>',
  void: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="M5.7 5.7l8.6 8.6"/></svg>',
  power: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.3v5.6"/><path d="M5.6 6a6 6 0 108.8 0"/></svg>'
};
// Icon-only table action button. `label` is the accessible name (screen
// readers) and doubles as the hover tooltip unless `title` overrides it.
function iconActionButton({ name, label, attr = '', extraClass = '', title }) {
  return `<button type="button" class="icon-action ${extraClass}" ${attr} title="${escapeHtml(title || label)}" aria-label="${escapeHtml(label)}">${TABLE_ICONS[name] || ''}</button>`;
}
function activeProducts() { return state.products.filter((product) => !product.archived); }
function isSuperAdmin() { return state.currentUser?.role === 'super-admin'; }
function userName(userId) { return state.userNames.find((user) => user.id === userId)?.name || 'Unknown user'; }
function unitDef(value) { return state.units.find((unit) => unit.value === value) || state.units[0] || { value: 'piece', label: 'Piece', shortLabel: 'pc', shortLabelPlural: 'pcs', fractional: false }; }
function unitShortLabel(value, quantity) { const def = unitDef(value); return Number(quantity) === 1 ? def.shortLabel : def.shortLabelPlural; }
// Mirrors store.js's roundQuantity so client-side cart totals never drift from
// what the backend will actually record.
function roundQty(value) { return Math.round(value * 1000) / 1000; }
function formatQuantity(value, fractional) {
  if (!fractional) return String(Math.round(Number(value) || 0));
  const rounded = roundQty(Number(value) || 0);
  return Number(rounded.toFixed(3)).toString();
}
function productStatus(product) {
  if (!product.stock) return ['Out of stock', 'danger'];
  if (product.stock <= product.lowStockThreshold) return ['Low stock', 'warning'];
  return ['In stock', 'success'];
}
function notify(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastRoot.append(toast);
  setTimeout(() => toast.remove(), 3500);
}
function showError(error) { notify(error?.message || 'Something went wrong. Please try again.', 'error'); }
async function refreshData() {
  const data = await window.kjStore.getData();
  state.products = data.products;
  state.sales = data.sales;
  state.categories = await window.kjStore.getCategories();
  state.units = await window.kjStore.getUnits();
  state.userNames = await window.kjStore.getUserNames();
}
function setPage(page) {
  if (page === 'users' && !isSuperAdmin()) page = 'dashboard';
  state.page = page;
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  render();
}
function emptyState(title, body, action = '') {
  return `<div class="empty-state"><div class="empty-icon">&#9634;</div><h3>${title}</h3><p>${body}</p>${action}</div>`;
}
function pageHeader(eyebrow, title, description, action = '') {
  return `<header class="page-header"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="subtitle">${description}</p></div>${action}</header>`;
}
function summaryCard(label, value, helper) { return `<article class="summary-card"><p>${label}</p><strong>${value}</strong><span>${helper}</span></article>`; }
function errorView(error) { return `<div class="empty-state"><h3>Could not load this page</h3><p>${escapeHtml(error?.message || 'Please try again.')}</p></div>`; }

// ---- Pagination (shared by Inventory, History, and User Management tables) ----

function pageNumberList(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const keep = new Set([1, 2, total - 1, total, current - 1, current, current + 1]);
  const sorted = [...keep].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const list = [];
  let previous = 0;
  for (const page of sorted) { if (previous && page - previous > 1) list.push('...'); list.push(page); previous = page; }
  return list;
}
// pageState is a small mutable { page, pageSize } object owned by the caller;
// this clamps it to the current total and returns matching markup for the
// existing .pagination/.page-button/.rows-per-page styles.
function paginationMarkup(pageState, total, noun) {
  const totalPages = Math.max(1, Math.ceil(total / pageState.pageSize));
  pageState.page = Math.min(Math.max(1, pageState.page), totalPages);
  const from = total === 0 ? 0 : ((pageState.page - 1) * pageState.pageSize) + 1;
  const to = Math.min(pageState.page * pageState.pageSize, total);
  const pages = pageNumberList(pageState.page, totalPages);
  return `<div class="pagination">
    <p class="pagination-info">Showing ${from}\u2013${to} of ${total} ${noun}</p>
    <div class="rows-per-page"><label for="rows-per-page-${noun}">Rows per page</label><select id="rows-per-page-${noun}" data-rows-per-page>${[10, 20, 50, 100].map((size) => `<option value="${size}" ${pageState.pageSize === size ? 'selected' : ''}>${size}</option>`).join('')}</select></div>
    <div class="pagination-controls">
      <button type="button" class="page-button" data-page-nav="prev" ${pageState.page <= 1 ? 'disabled' : ''}>Previous</button>
      ${pages.map((page) => page === '...' ? '<span class="page-ellipsis">&hellip;</span>' : `<button type="button" class="page-button ${page === pageState.page ? 'active' : ''}" data-page-nav="${page}" ${page === pageState.page ? 'aria-current="page"' : ''}>${page}</button>`).join('')}
      <button type="button" class="page-button" data-page-nav="next" ${pageState.page >= totalPages ? 'disabled' : ''}>Next</button>
    </div>
  </div>`;
}
function bindPagination(container, pageState, onChange) {
  container.querySelector('[data-rows-per-page]')?.addEventListener('change', (event) => {
    pageState.pageSize = Number(event.target.value);
    pageState.page = 1;
    onChange();
  });
  container.querySelectorAll('[data-page-nav]').forEach((button) => button.addEventListener('click', () => {
    const target = button.dataset.pageNav;
    if (target === 'prev') pageState.page = Math.max(1, pageState.page - 1);
    else if (target === 'next') pageState.page += 1;
    else pageState.page = Number(target);
    onChange();
  }));
}
function paginate(items, pageState) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageState.pageSize));
  pageState.page = Math.min(Math.max(1, pageState.page), totalPages);
  const start = (pageState.page - 1) * pageState.pageSize;
  return items.slice(start, start + pageState.pageSize);
}

function compactMoney(value) {
  if (value >= 1000) return `\u20B1${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return `\u20B1${Math.round(value)}`;
}
function lineChartMarkup(graph) {
  const width = 1000; const height = 320; const margin = { top: 20, right: 22, bottom: 49, left: 75 };
  const plotWidth = width - margin.left - margin.right; const plotHeight = height - margin.top - margin.bottom;
  const highestValue = Math.max(...graph.map((point) => point.total), 0);
  const maximum = highestValue ? Math.ceil(highestValue / 4) * 4 : 1;
  const coordinates = graph.map((point, index) => ({
    ...point,
    x: graph.length === 1 ? margin.left + (plotWidth / 2) : margin.left + ((plotWidth / (graph.length - 1)) * index),
    y: margin.top + plotHeight - ((point.total / maximum) * plotHeight)
  }));
  const line = coordinates.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  const area = `${line} L ${coordinates[coordinates.length - 1].x.toFixed(2)} ${(margin.top + plotHeight).toFixed(2)} L ${coordinates[0].x.toFixed(2)} ${(margin.top + plotHeight).toFixed(2)} Z`;
  const grid = [0, 1, 2, 3, 4].map((step) => {
    const value = maximum - ((maximum / 4) * step); const y = margin.top + ((plotHeight / 4) * step);
    return `<g><line class="chart-grid-line" x1="${margin.left}" x2="${width - margin.right}" y1="${y}" y2="${y}"/><text class="chart-y-label" x="${margin.left - 12}" y="${y + 4}">${compactMoney(value)}</text></g>`;
  }).join('');
  return `<div class="line-chart-wrap"><svg id="sales-line-chart" class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Sales totals over time"><defs><linearGradient id="sales-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#2f78eb" stop-opacity=".22"/><stop offset="100%" stop-color="#2f78eb" stop-opacity="0"/></linearGradient></defs>${grid}<path class="chart-area" d="${area}"/><path class="chart-line" d="${line}"/>${coordinates.map((point) => `<circle class="line-point" cx="${point.x}" cy="${point.y}" r="5" tabindex="0" data-chart-label="${escapeHtml(point.tooltip)}" data-chart-total="${escapeHtml(formatMoney(point.total))}" data-chart-transactions="${point.transactions}" data-chart-items="${point.itemsSold}"><title>${escapeHtml(point.tooltip)}: ${escapeHtml(formatMoney(point.total))}, ${point.transactions} transaction(s), ${point.itemsSold} item(s)</title></circle><text class="chart-x-label" x="${point.x}" y="${height - 14}">${escapeHtml(point.label)}</text>`).join('')}</svg><div id="chart-tooltip" class="chart-tooltip" role="status"></div></div>`;
}
function bindLineChartTooltip() {
  const wrapper = app.querySelector('.line-chart-wrap'); const tooltip = app.querySelector('#chart-tooltip');
  if (!wrapper || !tooltip) return;
  const show = (point, event) => {
    const wrapperBox = wrapper.getBoundingClientRect(); const pointBox = point.getBoundingClientRect();
    const x = event?.clientX ? event.clientX - wrapperBox.left : pointBox.left - wrapperBox.left + (pointBox.width / 2);
    const y = event?.clientY ? event.clientY - wrapperBox.top : pointBox.top - wrapperBox.top;
    tooltip.innerHTML = `<strong>${point.dataset.chartLabel}</strong><span>Sales: ${point.dataset.chartTotal}</span><span>Transactions: ${point.dataset.chartTransactions}</span><span>Items sold: ${point.dataset.chartItems}</span>`;
    tooltip.style.left = `${Math.max(62, Math.min(x, wrapperBox.width - 62))}px`;
    tooltip.style.top = `${Math.max(8, y - 12)}px`;
    tooltip.classList.add('visible');
  };
  wrapper.querySelectorAll('.line-point').forEach((point) => {
    point.addEventListener('mouseenter', (event) => show(point, event));
    point.addEventListener('mousemove', (event) => show(point, event));
    point.addEventListener('focus', () => show(point));
    point.addEventListener('mouseleave', () => tooltip.classList.remove('visible'));
    point.addEventListener('blur', () => tooltip.classList.remove('visible'));
  });
}

function dashboardFilterOptions(selected) {
  const option = (value, label) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`;
  return `<optgroup label="Date range">${option('today', 'Today')}${option('yesterday', 'Yesterday')}${option('this-week', 'This Week')}${option('last-7-days', 'Last 7 Days')}${option('this-month', 'This Month')}${option('last-30-days', 'Last 30 Days')}${option('this-year', 'This Year')}</optgroup><optgroup label="Trend view">${option('daily', 'Daily')}${option('weekly', 'Weekly')}${option('monthly', 'Monthly')}${option('yearly', 'Yearly')}</optgroup><optgroup label="Custom">${option('custom', 'Custom Date Range')}</optgroup>`;
}
function selectedFilterName(type) {
  return ({ today: 'Today', yesterday: 'Yesterday', 'this-week': 'This Week', 'last-7-days': 'Last 7 Days', 'this-month': 'This Month', 'last-30-days': 'Last 30 Days', 'this-year': 'This Year', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly', custom: 'Custom Range' })[type] || 'This Week';
}
function dashboardControls() {
  const custom = state.dashboardFilter.type === 'custom';
  const userOptions = isSuperAdmin() ? `<select id="dashboard-user" aria-label="Sales by user"><option value="">All Users</option>${state.userNames.map((user) => `<option value="${user.id}" ${state.dashboardFilter.userId === user.id ? 'selected' : ''}>${escapeHtml(user.name)}</option>`).join('')}</select>` : '';
  return `<div class="dashboard-controls">${userOptions}<select id="dashboard-filter" aria-label="Sales date filter">${dashboardFilterOptions(state.dashboardFilter.type)}</select>${custom ? `<label>Start<input id="dashboard-start" type="date" value="${escapeHtml(state.dashboardFilter.start)}"></label><label>End<input id="dashboard-end" type="date" value="${escapeHtml(state.dashboardFilter.end)}"></label><button id="apply-dashboard-range" class="primary-button">Apply</button>` : ''}</div>`;
}
function insightCard(title, insight, tone) {
  return `<article class="sales-insight ${tone}"><p>${title}</p><strong>${escapeHtml(insight.label)}</strong><span>${formatMoney(insight.total)}</span></article>`;
}
async function renderDashboard() {
  app.innerHTML = `${pageHeader('OVERVIEW', 'Dashboard', 'Track sales and inventory at a glance.')}<div class="loading">Loading your store data...</div>`;
  try {
    const dashboard = await window.kjStore.getDashboard(state.dashboardFilter);
    const { summary, graph, insights } = dashboard;
    app.innerHTML = `${pageHeader('OVERVIEW', 'Dashboard', 'Track sales and inventory at a glance.')}
      <section class="summary-grid">
        ${summaryCard('Total sales', formatMoney(summary.totalSales), selectedFilterName(dashboard.filter.type))}
        ${summaryCard('Transactions', summary.transactionCount, 'Completed sales in this period')}
        ${summaryCard('Items sold', summary.productsSold, 'Quantity from completed sales')}
        ${summaryCard('Average sale', formatMoney(summary.averageSale), 'Per completed transaction')}
      </section>
      <section class="panel chart-panel"><div class="section-heading"><div><h2>Sales performance</h2><p>Completed sales by period.</p></div>
        ${dashboardControls()}</div>
        ${summary.transactionCount ? lineChartMarkup(graph) : emptyState('No sales data available for this period.', 'Record a completed sale or choose another date range.')}
      </section>
      ${summary.transactionCount ? `<section class="sales-insights">${insightCard('Best sales day / period', insights.best, 'best')}${insightCard('Lowest sales day / period', insights.lowest, 'lowest')}</section>` : ''}`;
    app.querySelector('#dashboard-filter').addEventListener('change', (event) => { state.dashboardFilter.type = event.target.value; renderDashboard(); });
    app.querySelector('#dashboard-user')?.addEventListener('change', (event) => { state.dashboardFilter.userId = event.target.value; renderDashboard(); });
    app.querySelector('#apply-dashboard-range')?.addEventListener('click', () => {
      const start = app.querySelector('#dashboard-start').value;
      const end = app.querySelector('#dashboard-end').value;
      if (!start || !end) return notify('Choose both a start date and an end date.', 'error');
      if (end < start) return notify('The end date must be on or after the start date.', 'error');
      state.dashboardFilter.start = start;
      state.dashboardFilter.end = end;
      renderDashboard();
    });
    if (summary.transactionCount) bindLineChartTooltip();
  } catch (error) { app.innerHTML = errorView(error); }
}

function renderSale() {
  const categoryOptions = state.categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
  app.innerHTML = `${pageHeader('POINT OF SALE', 'Record Sale', 'Select products, review the cart, and complete the transaction.')}
    <div class="pos-layout"><section class="product-browser panel"><div class="product-filters"><input id="product-search" type="search" placeholder="Search products by name or SKU" autofocus><select id="product-category"><option value="">All categories</option>${categoryOptions}</select></div><div id="product-grid" class="product-grid"></div></section><aside class="cart panel" id="cart"></aside></div>`;
  app.querySelector('#product-search').addEventListener('input', renderSaleProducts);
  app.querySelector('#product-category').addEventListener('change', renderSaleProducts);
  renderSaleProducts(); renderCart();
}
function renderSaleProducts() {
  const search = app.querySelector('#product-search').value.trim().toLowerCase();
  const category = app.querySelector('#product-category').value;
  const products = activeProducts().filter((product) => (!category || product.category === category) && (!search || product.name.toLowerCase().includes(search) || product.sku.toLowerCase().includes(search)));
  const grid = app.querySelector('#product-grid');
  grid.innerHTML = products.length ? products.map((product) => { const def = unitDef(product.unit); return `<button class="product-card ${!product.stock ? 'sold-out' : ''}" data-add-product="${product.id}" ${!product.stock ? 'disabled' : ''}><span class="product-category">${escapeHtml(product.category)}</span><h3>${escapeHtml(product.name)}</h3><p>${product.sku ? `SKU: ${escapeHtml(product.sku)}` : '&nbsp;'}</p><div><strong>${formatMoney(product.price)}<small>/${def.shortLabel}</small></strong><span>${formatQuantity(product.stock, def.fractional)} ${unitShortLabel(product.unit, product.stock)} available</span></div></button>`; }).join('') : emptyState('No products found', 'Try a different search or add products in Inventory.');
  grid.querySelectorAll('[data-add-product]').forEach((button) => button.addEventListener('click', () => addToCart(button.dataset.addProduct)));
}
function addToCart(productId) {
  const product = activeProducts().find((item) => item.id === productId);
  if (!product || !product.stock) return;
  const def = unitDef(product.unit);
  // Fractional items start at 1 unit (or the full remaining stock if less than
  // 1 is left); the cashier can then type the exact amount in the cart.
  const step = def.fractional ? Math.min(1, product.stock) : 1;
  const existing = state.cart.find((item) => item.productId === productId);
  if (existing) {
    const next = roundQty(existing.quantity + step);
    if (next > product.stock) return notify(`Only ${formatQuantity(product.stock, def.fractional)} ${unitShortLabel(product.unit, product.stock)} of ${product.name} available.`, 'error');
    existing.quantity = next;
  } else {
    state.cart.push({ productId, quantity: roundQty(step) });
  }
  renderCart();
}
function cartDetails() { return state.cart.map((cartItem) => ({ ...cartItem, product: activeProducts().find((product) => product.id === cartItem.productId) })).filter((item) => item.product); }
function renderCart() {
  const cart = app.querySelector('#cart'); const items = cartDetails(); const subtotal = items.reduce((total, item) => total + (item.product.price * item.quantity), 0);
  cart.innerHTML = `<div class="cart-heading"><div><p class="eyebrow">CURRENT SALE</p><h2>Cart</h2></div><span class="cart-count">${items.length} item${items.length === 1 ? '' : 's'}</span></div><div class="cart-items">${items.length ? items.map((item) => { const def = unitDef(item.product.unit); const quantityControl = def.fractional ? `<div class="quantity-control fractional"><input type="number" min="0.001" step="0.001" max="${item.product.stock}" value="${formatQuantity(item.quantity, true)}" data-quantity-input="${item.productId}"><span class="quantity-unit">${def.shortLabel}</span></div>` : `<div class="quantity-control"><button data-quantity="${item.productId}" data-change="-1">&minus;</button><span>${item.quantity}</span><button data-quantity="${item.productId}" data-change="1">+</button></div>`; return `<article class="cart-item"><div><h3>${escapeHtml(item.product.name)}</h3><p>${formatMoney(item.product.price)} per ${def.shortLabel}</p></div><button class="icon-button remove" data-remove="${item.productId}" title="Remove item">&times;</button><div class="cart-line">${quantityControl}<strong>${formatMoney(item.product.price * item.quantity)}</strong></div></article>`; }).join('') : emptyState('Your cart is empty', 'Click a product card to add it to this sale.')}</div><div class="cart-totals"><div><span>Subtotal</span><strong>${formatMoney(subtotal)}</strong></div><div><span>Items</span><strong>${items.length}</strong></div><div class="grand-total"><span>Grand total</span><strong>${formatMoney(subtotal)}</strong></div><button id="complete-sale" class="primary-button wide" ${items.length ? '' : 'disabled'}>Complete Sale</button></div>`;
  cart.querySelectorAll('[data-quantity]').forEach((button) => button.addEventListener('click', () => changeQuantity(button.dataset.quantity, Number(button.dataset.change))));
  cart.querySelectorAll('[data-quantity-input]').forEach((input) => input.addEventListener('change', () => setQuantity(input.dataset.quantityInput, Number(input.value))));
  cart.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => { state.cart = state.cart.filter((item) => item.productId !== button.dataset.remove); renderCart(); }));
  cart.querySelector('#complete-sale').addEventListener('click', completeSale);
}
function changeQuantity(productId, change) { const cartItem = state.cart.find((item) => item.productId === productId); const product = activeProducts().find((item) => item.id === productId); if (cartItem.quantity + change < 1) state.cart = state.cart.filter((item) => item.productId !== productId); else if (cartItem.quantity + change > product.stock) notify(`Only ${product.stock} ${product.name} available.`, 'error'); else cartItem.quantity += change; renderCart(); }
function setQuantity(productId, value) {
  const cartItem = state.cart.find((item) => item.productId === productId);
  const product = activeProducts().find((item) => item.id === productId);
  if (!cartItem || !product) return;
  const rounded = roundQty(value);
  if (!Number.isFinite(rounded) || rounded <= 0) { state.cart = state.cart.filter((item) => item.productId !== productId); renderCart(); return; }
  if (rounded > product.stock) { notify(`Only ${formatQuantity(product.stock, true)} ${unitShortLabel(product.unit, product.stock)} of ${product.name} available.`, 'error'); cartItem.quantity = product.stock; } else { cartItem.quantity = rounded; }
  renderCart();
}
async function completeSale() { try { const sale = await window.kjStore.completeSale(state.cart); state.cart = []; await refreshData(); renderSale(); notify(`Sale ${sale.id} completed successfully.`); } catch (error) { showError(error); await refreshData(); renderSale(); } }

function renderInventory() {
  const categoryOptions = state.categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
  app.innerHTML = `${pageHeader('CATALOG', 'Inventory', 'Add, edit, and monitor the products you sell.', '<div class="header-actions"><button id="import-inventory" class="secondary-button">Import CSV</button><button id="export-inventory" class="secondary-button">Export CSV</button><button id="add-product" class="primary-button">+ Add New Product</button></div>')}<section class="panel"><div class="table-filters"><input id="inventory-search" type="search" placeholder="Search product name or SKU"><select id="inventory-category"><option value="">All categories</option>${categoryOptions}</select></div><div id="inventory-table"></div></section>`;
  const resetAndRender = () => { state.inventoryPagination.page = 1; renderInventoryTable(); };
  app.querySelector('#add-product').addEventListener('click', () => openProductModal()); app.querySelector('#inventory-search').addEventListener('input', resetAndRender); app.querySelector('#inventory-category').addEventListener('change', resetAndRender); renderInventoryTable();
  app.querySelector('#export-inventory').addEventListener('click', exportInventoryCsv);
  app.querySelector('#import-inventory').addEventListener('click', startInventoryImport);
}
async function exportInventoryCsv() {
  const button = app.querySelector('#export-inventory');
  const filters = { search: app.querySelector('#inventory-search')?.value || '', category: app.querySelector('#inventory-category')?.value || '' };
  button.disabled = true;
  try {
    const result = await window.kjStore.exportInventory(filters);
    if (result.saved) notify(`Inventory exported to ${result.path}.`);
  } catch (error) { showError(error); } finally { button.disabled = false; }
}
async function startInventoryImport() {
  const button = app.querySelector('#import-inventory');
  button.disabled = true;
  try {
    const file = await window.kjStore.chooseImportFile();
    if (!file) return; // user canceled the file picker
    const preview = await window.kjStore.previewImport(file.text);
    openImportPreviewModal(file, preview);
  } catch (error) { showError(error); } finally { button.disabled = false; }
}
function importStatusBadge(status) {
  if (status === 'new') return '<span class="badge success">New</span>';
  if (status === 'duplicate') return '<span class="badge warning">Existing SKU</span>';
  return '<span class="badge danger">Error</span>';
}
function openImportPreviewModal(file, preview) {
  const canImport = preview.newCount + preview.duplicateCount > 0;
  const rowsHtml = preview.rows.map((row) => `<tr><td>${row.rowNumber}</td><td>${escapeHtml(row.name || '&mdash;')}</td><td>${escapeHtml(row.sku || '&mdash;')}</td><td>${escapeHtml(row.category || '&mdash;')}</td><td>${row.stock ?? '&mdash;'} ${row.unit ? escapeHtml(row.unit) : ''}</td><td>${importStatusBadge(row.status)}</td><td>${row.errors.length ? escapeHtml(row.errors.join(' ')) : ''}</td></tr>`).join('');
  openModal(`<div class="modal-header"><div><h2>Import Products</h2><p>${escapeHtml(file.fileName)} &mdash; ${preview.totalRows} row${preview.totalRows === 1 ? '' : 's'} found.</p></div><button data-close-modal class="icon-button">&times;</button></div>
    <div class="import-summary"><span class="badge success">${preview.newCount} new</span><span class="badge warning">${preview.duplicateCount} existing SKU</span><span class="badge danger">${preview.errorCount} error${preview.errorCount === 1 ? '' : 's'}</span></div>
    <div class="import-preview-table"><table><thead><tr><th>Row</th><th>Name</th><th>SKU</th><th>Category</th><th>Stock</th><th>Status</th><th>Notes</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
    ${preview.duplicateCount ? `<div class="form-grid"><label class="full">Existing SKUs found &mdash; how should they be handled?<select id="import-duplicate-strategy"><option value="skip">Skip existing products (only add new ones)</option><option value="update">Update existing products with the file's values</option></select></label></div>` : ''}
    <div class="modal-actions"><button type="button" data-close-modal class="secondary-button">Cancel</button><button id="confirm-import" class="primary-button" ${canImport ? '' : 'disabled'}>${canImport ? `Import ${preview.newCount + preview.duplicateCount} Record${preview.newCount + preview.duplicateCount === 1 ? '' : 's'}` : 'No valid rows to import'}</button></div>`);
  modalRoot.querySelector('#confirm-import')?.addEventListener('click', async (event) => {
    const confirmButton = event.currentTarget;
    confirmButton.disabled = true;
    confirmButton.textContent = 'Importing...';
    const duplicateStrategy = modalRoot.querySelector('#import-duplicate-strategy')?.value || 'skip';
    try {
      const result = await window.kjStore.commitImport(file.text, duplicateStrategy);
      await refreshData();
      renderInventory();
      openImportResultModal(result);
    } catch (error) { showError(error); confirmButton.disabled = false; confirmButton.textContent = 'Try Again'; }
  });
}
function openImportResultModal(result) {
  const errorList = result.errors.length ? `<ul class="import-error-list">${result.errors.map((row) => `<li>Row ${row.rowNumber}: ${escapeHtml(row.errors.join(' '))}</li>`).join('')}</ul>` : '';
  openModal(`<div class="modal-header"><div><h2>Import Complete</h2></div><button data-close-modal class="icon-button">&times;</button></div>
    <ul class="import-result-list">
      <li>${result.imported} record${result.imported === 1 ? '' : 's'} imported</li>
      <li>${result.updated} record${result.updated === 1 ? '' : 's'} updated</li>
      <li>${result.skipped} record${result.skipped === 1 ? '' : 's'} skipped</li>
      <li>${result.errorCount} record${result.errorCount === 1 ? '' : 's'} contain errors</li>
    </ul>
    ${errorList}
    <div class="modal-actions"><button data-close-modal class="primary-button">Done</button></div>`);
}
function renderInventoryTable() {
  const search = app.querySelector('#inventory-search').value.trim().toLowerCase(); const category = app.querySelector('#inventory-category').value; const filtered = activeProducts().filter((product) => (!category || product.category === category) && (!search || product.name.toLowerCase().includes(search) || product.sku.toLowerCase().includes(search))); const table = app.querySelector('#inventory-table');
  if (!filtered.length) { table.innerHTML = emptyState('No products yet', 'Add your first product to start managing inventory.', '<button class="secondary-button" id="empty-add">Add New Product</button>'); document.querySelector('#empty-add')?.addEventListener('click', () => openProductModal()); return; }
  const pageState = state.inventoryPagination;
  const products = paginate(filtered, pageState);
  table.innerHTML = `<div class="data-table-wrap"><table><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th aria-label="Actions"></th></tr></thead><tbody>${products.map((product) => { const [label, style] = productStatus(product); const def = unitDef(product.unit); return `<tr><td><strong>${escapeHtml(product.name)}</strong><small>${product.sku ? `SKU: ${escapeHtml(product.sku)}` : 'No SKU'}</small></td><td>${escapeHtml(product.category)}</td><td>${formatMoney(product.price)} <small>/ ${def.shortLabel}</small></td><td>${formatQuantity(product.stock, def.fractional)} ${unitShortLabel(product.unit, product.stock)}</td><td><span class="badge ${style}">${label}</span></td><td class="row-actions">${iconActionButton({ name: 'edit', label: 'Edit', attr: `data-edit="${product.id}"` })}${iconActionButton({ name: 'archive', label: 'Archive', attr: `data-archive="${product.id}"`, extraClass: 'danger' })}</td></tr>`; }).join('')}</tbody></table></div>${paginationMarkup(pageState, filtered.length, 'products')}`;
  table.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => openProductModal(activeProducts().find((item) => item.id === button.dataset.edit)))); table.querySelectorAll('[data-archive]').forEach((button) => button.addEventListener('click', () => confirmArchive(button.dataset.archive)));
  bindPagination(table, pageState, renderInventoryTable);
}

function renderHistory() {
  // Monday-start week, matching the Dashboard's "this week" filter. Built from
  // local date parts (not toISOString) so a timezone offset can't shift the
  // date backward/forward by a day.
  const now = new Date();
  const mondayOffset = now.getDay() === 0 ? 6 : now.getDay() - 1;
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset);
  const defaultStart = `${startOfWeek.getFullYear()}-${String(startOfWeek.getMonth() + 1).padStart(2, '0')}-${String(startOfWeek.getDate()).padStart(2, '0')}`;
  const defaultEnd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const archiveAction = isSuperAdmin() ? '<button id="archive-old-sales" class="secondary-button">Archive Old Sales</button>' : '';
  app.innerHTML = `${pageHeader('TRANSACTIONS', 'History', 'Review completed sales and transaction details.', archiveAction)}<section class="panel"><div class="table-filters history-filters"><input id="history-search" type="search" placeholder="Search transaction ID"><label>From <input id="history-start" type="date" value="${defaultStart}"></label><label>To <input id="history-end" type="date" value="${defaultEnd}"></label><label class="checkbox-label"><input id="history-include-archived" type="checkbox"> Include archived sales</label></div><p class="filter-hint">Showing this week by default to keep things fast. Widen the date range or check "Include archived sales" to search older history.</p><div id="history-table" class="loading">Loading transactions...</div></section>`;
  ['history-search', 'history-start', 'history-end'].forEach((id) => app.querySelector(`#${id}`).addEventListener('input', () => { state.historyPagination.page = 1; renderHistoryTable(); }));
  app.querySelector('#history-include-archived').addEventListener('change', () => { state.historyPagination.page = 1; renderHistoryTable(); });
  app.querySelector('#archive-old-sales')?.addEventListener('click', openArchiveOldSalesModal);
  renderHistoryTable();
}
async function renderHistoryTable() {
  const table = app.querySelector('#history-table'); table.innerHTML = '<div class="loading">Loading transactions...</div>';
  try {
    const allSales = await window.kjStore.listSales({ search: app.querySelector('#history-search').value, start: app.querySelector('#history-start').value, end: app.querySelector('#history-end').value, includeArchived: app.querySelector('#history-include-archived').checked });
    if (!allSales.length) { table.innerHTML = emptyState('No transactions found', 'Completed sales will appear here.'); return; }
    const pageState = state.historyPagination;
    const sales = paginate(allSales, pageState);
    table.innerHTML = `<div class="data-table-wrap"><table><thead><tr><th>Transaction ID</th><th>Date & time</th><th>Processed By</th><th>Items</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>${sales.map((sale) => `<tr><td><strong>${escapeHtml(sale.id)}</strong></td><td>${dateTime.format(new Date(sale.createdAt))}</td><td>${sale.userId ? escapeHtml(userName(sale.userId)) : '&mdash;'}</td><td>${sale.itemCount}</td><td>${formatMoney(sale.total)}</td><td><span class="badge ${sale.status === 'Voided' ? 'danger' : 'success'}">${sale.status}</span></td><td class="row-actions">${iconActionButton({ name: 'view', label: 'View details', attr: `data-sale-detail="${sale.id}"` })}${iconActionButton({ name: 'printer', label: 'Print Receipt', attr: `data-print-receipt="${sale.id}"` })}${isSuperAdmin() && sale.status !== 'Voided' ? iconActionButton({ name: 'void', label: 'Void Sale', attr: `data-void-sale="${sale.id}"`, extraClass: 'danger' }) : ''}</td></tr>`).join('')}</tbody></table></div>${paginationMarkup(pageState, allSales.length, 'transactions')}`;
    table.querySelectorAll('[data-sale-detail]').forEach((button) => button.addEventListener('click', () => openSaleDetail(button.dataset.saleDetail)));
    table.querySelectorAll('[data-print-receipt]').forEach((button) => button.addEventListener('click', () => printSaleReceipt(button.dataset.printReceipt, button)));
    table.querySelectorAll('[data-void-sale]').forEach((button) => button.addEventListener('click', () => openVoidSaleModal(button.dataset.voidSale)));
    bindPagination(table, pageState, renderHistoryTable);
  } catch (error) { table.innerHTML = errorView(error); }
}

// ---- Archive Old Sales (Super Admin only, performance maintenance) ----

async function openArchiveOldSalesModal() {
  let summary = [];
  try { summary = await window.kjStore.getArchiveSummary(); } catch (error) { showError(error); return; }
  const summaryText = summary.length
    ? summary.map((entry) => `${entry.year} (${entry.count.toLocaleString()})`).join(', ')
    : 'No sales have been archived yet.';
  const defaultCutoff = new Date(new Date().getFullYear() - 1, 0, 1).toISOString().slice(0, 10);
  openModal(`<div class="modal-header"><div><h2>Archive Old Sales</h2><p>Moves old sales out of the active database into a separate file per year, to keep everyday use fast. Nothing is deleted, and archived sales still appear in History and reports when needed.</p></div><button data-close-modal class="icon-button">&times;</button></div>
    <p class="filter-hint">Already archived: ${escapeHtml(summaryText)}</p>
    <div id="archive-error"></div>
    <form id="archive-form"><div class="form-grid"><label class="full">Archive sales completed before<input name="cutoff" type="date" required value="${defaultCutoff}"></label></div>
    <div class="modal-actions"><button type="button" data-close-modal class="secondary-button">Cancel</button><button class="primary-button">Archive Sales</button></div></form>`);
  modalRoot.querySelector('#archive-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = modalRoot.querySelector('#archive-error');
    const submitButton = event.currentTarget.querySelector('button.primary-button');
    const cutoff = new FormData(event.currentTarget).get('cutoff');
    submitButton.disabled = true;
    submitButton.textContent = 'Archiving...';
    try {
      const result = await window.kjStore.archiveSalesBefore(cutoff);
      closeModal();
      if (!result.archivedCount) notify('No sales were old enough to archive.');
      else notify(`${result.archivedCount.toLocaleString()} sale${result.archivedCount === 1 ? '' : 's'} archived (${result.years.join(', ')}). ${result.remaining.toLocaleString()} remain active.`);
      renderHistoryTable();
    } catch (error) {
      errorBox.innerHTML = `<p class="form-error">${escapeHtml(error?.message || 'Could not archive sales.')}</p>`;
      submitButton.disabled = false;
      submitButton.textContent = 'Archive Sales';
    }
  });
}

// ---- Void Sale (correcting mistakes without editing/deleting the record) ----

function openVoidSaleModal(saleId) {
  openModal(`<div class="modal-header"><div><h2>Void Sale ${escapeHtml(saleId)}</h2><p>This restores the deducted stock. The transaction stays in History, marked Voided, for the audit trail.</p></div><button data-close-modal class="icon-button">&times;</button></div>
    <div id="void-error"></div>
    <form id="void-form"><div class="form-grid"><label class="full">Reason for voiding<textarea name="reason" rows="3" maxlength="200" required placeholder="e.g. Wrong item scanned, customer changed mind"></textarea></label></div>
    <div class="modal-actions"><button type="button" data-close-modal class="secondary-button">Cancel</button><button class="danger-button">Void Sale</button></div></form>`);
  modalRoot.querySelector('#void-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = modalRoot.querySelector('#void-error');
    const submitButton = event.currentTarget.querySelector('button.danger-button');
    const reason = new FormData(event.currentTarget).get('reason');
    submitButton.disabled = true;
    submitButton.textContent = 'Voiding...';
    try {
      await window.kjStore.voidSale(saleId, reason);
      closeModal();
      renderHistoryTable();
      notify('Sale voided and stock restored.');
    } catch (error) {
      errorBox.innerHTML = `<p class="form-error">${escapeHtml(error?.message || 'Could not void this sale.')}</p>`;
      submitButton.disabled = false;
      submitButton.textContent = 'Void Sale';
    }
  });
}

// ---- Print Receipt (built from scratch: no prior receipt/print code existed) ----

function choosePaperWidth() {
  return new Promise((resolve) => {
    openModal(`<div class="modal-header"><div><h2>Print Receipt</h2><p>Choose the thermal paper width for this printer.</p></div><button data-close-modal class="icon-button">&times;</button></div><div class="modal-actions"><button type="button" data-close-modal class="secondary-button">Cancel</button><button id="width-58" class="secondary-button">58mm</button><button id="width-80" class="primary-button">80mm</button></div>`);
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; resolve(value); closeModal(); };
    modalRoot.querySelector('#width-58').addEventListener('click', () => finish('58mm'));
    modalRoot.querySelector('#width-80').addEventListener('click', () => finish('80mm'));
    modalRoot.querySelectorAll('[data-close-modal]').forEach((element) => element.addEventListener('click', () => finish(null)));
    modalRoot.querySelector('.modal-backdrop').addEventListener('click', (event) => { if (event.target === event.currentTarget) finish(null); });
  });
}
async function printSaleReceipt(saleId, button) {
  if (button.disabled) return; // guards against repeated clicks spawning multiple print jobs
  const paperWidth = await choosePaperWidth();
  if (!paperWidth) return; // user canceled the width choice
  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = 'Printing...';
  try {
    const result = await window.kjStore.printReceipt(saleId, paperWidth);
    if (result.printed) notify('Receipt sent to the printer.');
    else if (!result.cancelled) notify(`Could not print the receipt${result.reason ? ` (${result.reason})` : ''}.`, 'error');
  } catch (error) { showError(error); } finally { button.disabled = false; button.textContent = originalLabel; }
}

function render() {
  if (state.page === 'dashboard') renderDashboard();
  else if (state.page === 'sale') renderSale();
  else if (state.page === 'inventory') renderInventory();
  else if (state.page === 'users') renderUsers();
  else renderHistory();
}
function closeModal() { modalRoot.innerHTML = ''; }
function openModal(content) { modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true">${content}</section></div>`; modalRoot.querySelector('.modal-backdrop').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeModal(); }); modalRoot.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', closeModal)); }
function openProductModal(product = null) {
  const title = product ? 'Edit Product' : 'Add New Product'; const categoryOptions = state.categories.map((category) => `<option value="${escapeHtml(category)}" ${product?.category === category ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('');
  const selectedUnit = product?.unit || 'piece';
  const unitOptions = state.units.map((unit) => `<option value="${unit.value}" ${selectedUnit === unit.value ? 'selected' : ''}>${escapeHtml(unit.label)}</option>`).join('');
  const startingDef = unitDef(selectedUnit);
  openModal(`<div class="modal-header"><div><h2>${title}</h2><p>Enter the product details below.</p></div><button data-close-modal class="icon-button">&times;</button></div><form id="product-form"><div class="form-grid"><label class="full">Product name<input name="name" required maxlength="100" value="${escapeHtml(product?.name || '')}"></label><label>SKU / barcode<input name="sku" maxlength="80" value="${escapeHtml(product?.sku || '')}"></label><label>Category<select name="category" required><option value="">Choose category</option>${categoryOptions}</select></label><label>Unit of measurement<select name="unit" id="product-unit">${unitOptions}</select></label><label>Selling price<input name="price" type="number" min="0" step="0.01" required value="${product?.price ?? ''}"></label><label>Stock quantity<input name="stock" id="product-stock" type="number" min="0" step="${startingDef.fractional ? '0.001' : '1'}" required value="${product?.stock ?? ''}"></label><label>Low-stock level<input name="lowStockThreshold" id="product-low-stock" type="number" min="0" step="${startingDef.fractional ? '0.001' : '1'}" required value="${product?.lowStockThreshold ?? 5}"></label><p class="unit-hint full" id="unit-hint">${unitHintText(startingDef)}</p></div><div class="modal-actions"><button type="button" data-close-modal class="secondary-button">Cancel</button><button class="primary-button">${product ? 'Save Changes' : 'Add Product'}</button></div></form>`);
  modalRoot.querySelector('#product-unit').addEventListener('change', (event) => {
    const def = unitDef(event.target.value);
    modalRoot.querySelector('#product-stock').step = def.fractional ? '0.001' : '1';
    modalRoot.querySelector('#product-low-stock').step = def.fractional ? '0.001' : '1';
    modalRoot.querySelector('#unit-hint').innerHTML = unitHintText(def);
  });
  modalRoot.querySelector('#product-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const input = Object.fromEntries(form.entries()); try { if (product) await window.kjStore.updateProduct(product.id, input); else await window.kjStore.createProduct(input); await refreshData(); closeModal(); renderInventory(); notify(product ? 'Product updated.' : 'Product added to inventory.'); } catch (error) { showError(error); } });
}
function unitHintText(def) {
  if (!def.fractional) return `Stocked and sold by the whole ${def.label.toLowerCase()}.`;
  return `Stocked and sold in ${def.label.toLowerCase()}. Buying in bulk (e.g. a 50kg sack)? Add its total in ${def.shortLabel} \u2014 for a 50kg sack, enter <strong>50</strong>.`;
}
function confirmArchive(productId) { const product = activeProducts().find((item) => item.id === productId); openModal(`<div class="modal-header"><div><h2>Archive product?</h2><p>${escapeHtml(product.name)} will no longer be available to sell. Historical sales remain intact.</p></div><button data-close-modal class="icon-button">&times;</button></div><div class="modal-actions"><button data-close-modal class="secondary-button">Cancel</button><button id="confirm-archive" class="danger-button">Archive Product</button></div>`); modalRoot.querySelector('#confirm-archive').addEventListener('click', async () => { try { await window.kjStore.archiveProduct(productId); await refreshData(); closeModal(); renderInventory(); notify('Product archived.'); } catch (error) { showError(error); } }); }
async function openSaleDetail(id) { try { const sale = await window.kjStore.getSale(id); openModal(`<div class="modal-header"><div><p class="eyebrow">TRANSACTION</p><h2>${escapeHtml(sale.id)} ${sale.status === 'Voided' ? '<span class="badge danger">Voided</span>' : ''}</h2><p>${dateTime.format(new Date(sale.createdAt))} &middot; Processed By: ${sale.userId ? escapeHtml(userName(sale.userId)) : 'Unknown user'}</p></div><button data-close-modal class="icon-button">&times;</button></div>${sale.status === 'Voided' ? `<div class="void-notice"><strong>Voided</strong> ${dateTime.format(new Date(sale.voidedAt))} by ${escapeHtml(userName(sale.voidedBy))}<br>Reason: ${escapeHtml(sale.voidReason)}</div>` : ''}<div class="receipt-items">${sale.items.map((item) => { const def = unitDef(item.unit); return `<div><div><strong>${escapeHtml(item.productName)}</strong><small>${formatQuantity(item.quantity, def.fractional)} ${unitShortLabel(item.unit, item.quantity)} &times; ${formatMoney(item.unitPrice)}</small></div><strong>${formatMoney(item.subtotal)}</strong></div>`; }).join('')}</div><div class="receipt-total"><span>Total (${sale.itemCount} items)</span><strong>${formatMoney(sale.total)}</strong></div><div class="modal-actions"><button data-close-modal class="secondary-button">Close</button></div>`); } catch (error) { showError(error); } }

// ---- Authentication ----

function renderLogin() {
  document.body.classList.add('unauthenticated');
  app.innerHTML = `<div class="login-screen"><div class="login-card">
    <div class="brand"><span class="brand-mark">KJ</span><span>KJ STORE</span></div>
    <h1>Sign in</h1><p class="subtitle">Enter your account to continue.</p>
    <div id="login-error"></div>
    <form id="login-form">
      <label>Email or username<input name="username" required autofocus autocomplete="username"></label>
      <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
      <button id="login-submit" class="primary-button wide" type="submit">Sign In</button>
    </form>
  </div></div>`;
  app.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = app.querySelector('#login-error');
    const submitButton = app.querySelector('#login-submit');
    errorBox.innerHTML = '';
    const form = new FormData(event.currentTarget);
    const username = String(form.get('username') || '').trim();
    const password = String(form.get('password') || '');
    if (!username || !password) { errorBox.innerHTML = `<p class="form-error">Enter your username and password.</p>`; return; }
    submitButton.disabled = true;
    submitButton.textContent = 'Signing in...';
    try {
      const user = await window.kjStore.login(username, password);
      state.currentUser = user;
      document.body.classList.remove('unauthenticated');
      await refreshData();
      applyRoleVisibility();
      renderSessionPanel();
      setPage('dashboard');
    } catch (error) {
      errorBox.innerHTML = `<p class="form-error">${escapeHtml(error?.message || 'Invalid username or password.')}</p>`;
      submitButton.disabled = false;
      submitButton.textContent = 'Sign In';
    }
  });
}

function renderSessionPanel() {
  const panel = document.querySelector('#session-panel');
  if (!state.currentUser) { panel.innerHTML = ''; return; }
  panel.innerHTML = `<strong>${escapeHtml(state.currentUser.name)}</strong><span>${escapeHtml(state.currentUser.role.replace('-', ' '))}</span><button id="logout-button" type="button">Log out</button>`;
  panel.querySelector('#logout-button').addEventListener('click', async () => {
    await window.kjStore.logout();
    state.currentUser = null;
    state.page = 'dashboard';
    panel.innerHTML = '';
    renderLogin();
  });
}

function applyRoleVisibility() {
  document.querySelectorAll('.nav-item[data-role]').forEach((button) => { button.style.display = button.dataset.role === state.currentUser?.role ? '' : 'none'; });
}

// ---- User Management (Super Admin only) ----

function statusBadge(active) { return `<span class="badge ${active ? 'success' : 'danger'}">${active ? 'Active' : 'Inactive'}</span>`; }
function roleBadge(role) { return `<span class="badge role ${role}">${role === 'super-admin' ? 'Super Admin' : 'Regular User'}</span>`; }

async function renderUsers() {
  app.innerHTML = `${pageHeader('TEAM', 'User Management', 'Create accounts and control who can access KJ STORE.', '<button id="add-user" class="primary-button">+ Add User</button>')}<section class="panel"><div id="users-table" class="loading">Loading users...</div></section>`;
  app.querySelector('#add-user').addEventListener('click', () => openUserModal());
  await renderUsersTable();
}
async function renderUsersTable() {
  const table = app.querySelector('#users-table');
  try {
    const allUsers = await window.kjStore.listUsers();
    state.users = allUsers;
    if (!allUsers.length) { table.innerHTML = emptyState('No users yet', 'Add your first team account.'); return; }
    const pageState = state.usersPagination;
    const users = paginate(allUsers, pageState);
    table.innerHTML = `<div class="data-table-wrap"><table><thead><tr><th>Name</th><th>Email/Username</th><th>Role</th><th>Status</th><th>Created</th><th>Last login</th><th></th></tr></thead><tbody>${users.map((user) => { const isSelf = user.id === state.currentUser?.id; return `<tr><td><strong>${escapeHtml(user.name)}</strong>${isSelf ? ' <small>(you)</small>' : ''}</td><td>${escapeHtml(user.username)}</td><td>${roleBadge(user.role)}</td><td>${statusBadge(user.active)}</td><td>${dateTime.format(new Date(user.createdAt))}</td><td>${user.lastLoginAt ? dateTime.format(new Date(user.lastLoginAt)) : 'Never'}</td><td class="row-actions">${iconActionButton({ name: 'edit', label: 'Edit', attr: `data-edit-user="${user.id}"` })}${iconActionButton({ name: 'power', label: user.active ? 'Deactivate' : 'Activate', attr: `data-toggle-user="${user.id}" ${isSelf ? 'disabled' : ''}`, extraClass: user.active ? 'danger' : 'success', title: isSelf ? 'You cannot deactivate your own account.' : undefined })}</td></tr>`; }).join('')}</tbody></table></div>${paginationMarkup(pageState, allUsers.length, 'users')}`;
    table.querySelectorAll('[data-edit-user]').forEach((button) => button.addEventListener('click', () => openUserModal(state.users.find((user) => user.id === button.dataset.editUser))));
    table.querySelectorAll('[data-toggle-user]').forEach((button) => button.addEventListener('click', () => toggleUserActive(button.dataset.toggleUser)));
    bindPagination(table, pageState, renderUsersTable);
  } catch (error) { table.innerHTML = errorView(error); }
}
function openUserModal(user = null) {
  const title = user ? 'Edit User' : 'Add User';
  const isSelf = user && user.id === state.currentUser?.id;
  openModal(`<div class="modal-header"><div><h2>${title}</h2><p>${user ? 'Update this account.' : 'Enter the new account details.'}</p></div><button data-close-modal class="icon-button">&times;</button></div>
    <div id="user-form-error"></div>
    <form id="user-form"><div class="form-grid">
      <label class="full">Full name<input name="name" required maxlength="80" value="${escapeHtml(user?.name || '')}"></label>
      <label class="full">Email / username<input name="username" required maxlength="100" value="${escapeHtml(user?.username || '')}"></label>
      <label class="full">${user ? 'New password (leave blank to keep current)' : 'Password'}<input name="password" type="password" autocomplete="new-password" ${user ? '' : 'required'} minlength="8"></label>
      <label>Role<select name="role" ${isSelf ? 'disabled' : ''}><option value="regular-user" ${user?.role === 'regular-user' ? 'selected' : ''}>Regular User</option><option value="super-admin" ${user?.role === 'super-admin' ? 'selected' : ''}>Super Admin</option></select></label>
      <label>Status<select name="active" ${isSelf ? 'disabled' : ''}><option value="true" ${user?.active !== false ? 'selected' : ''}>Active</option><option value="false" ${user?.active === false ? 'selected' : ''}>Inactive</option></select></label>
    </div><div class="modal-actions"><button type="button" data-close-modal class="secondary-button">Cancel</button><button class="primary-button">${user ? 'Save Changes' : 'Add User'}</button></div></form>`);
  if (isSelf) modalRoot.querySelector('#user-form-error').innerHTML = `<p class="form-error">You can't change your own role or status.</p>`;
  modalRoot.querySelector('#user-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = modalRoot.querySelector('#user-form-error');
    const input = Object.fromEntries(new FormData(event.currentTarget).entries());
    // The role/status selects are disabled when editing your own account, which
    // means the browser omits them from FormData entirely — restore them here
    // rather than letting them silently default away.
    if (isSelf) { input.role = user.role; input.active = user.active; }
    try {
      if (user) await window.kjStore.updateUser(user.id, input);
      else await window.kjStore.createUser(input);
      await renderUsersTable();
      closeModal();
      notify(user ? 'User updated.' : 'User created.');
    } catch (error) { errorBox.innerHTML = `<p class="form-error">${escapeHtml(error?.message || 'Something went wrong.')}</p>`; }
  });
}
async function toggleUserActive(userId) {
  const user = state.users.find((item) => item.id === userId);
  if (!user) return;
  try {
    await window.kjStore.updateUser(userId, { name: user.name, username: user.username, role: user.role, active: !user.active });
    await renderUsersTable();
    notify(user.active ? 'User deactivated.' : 'User activated.');
  } catch (error) { showError(error); }
}

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => setPage(button.dataset.page)));

(async function start() {
  try {
    const session = await window.kjStore.getSession();
    if (!session) { renderLogin(); return; }
    state.currentUser = session;
    document.body.classList.remove('unauthenticated');
    await refreshData();
    applyRoleVisibility();
    renderSessionPanel();
    render();
  } catch (error) { app.innerHTML = errorView(error); }
})();
