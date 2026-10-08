const app = document.querySelector('#app');
const modalRoot = document.querySelector('#modal-root');
const toastRoot = document.querySelector('#toast-root');

const state = { page: 'dashboard', products: [], sales: [], cart: [], discount: 0, categories: [], units: [], userNames: [], users: [], currentUser: null, receiptPaperWidth: '80mm', maxRegularUserDiscountPercent: 20, dashboardFilter: { type: 'this-week', start: '', end: '', userId: '' }, inventoryPagination: { page: 1, pageSize: 20 }, historyPagination: { page: 1, pageSize: 20 }, usersPagination: { page: 1, pageSize: 20 }, auditPagination: { page: 1, pageSize: 25 } };
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
// Most fractional units (kg, liter, ...) allow fine thousandths; a unit can
// override this with its own coarser `step` (e.g. "load" moves in quarters,
// since that's how dump-truck loads are actually ordered/priced).
function quantityStep(def) { return String(def.step ?? (def.fractional ? 0.001 : 1)); }
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
  try {
    const settings = await window.kjStore.getSettings();
    state.receiptPaperWidth = settings.receiptPaperWidth || '80mm';
    state.maxRegularUserDiscountPercent = settings.maxRegularUserDiscountPercent ?? 20;
  } catch { /* keep previous/default values */ }
}
// Pages a Regular User (Cashier) cannot open. Dashboard stays Super-Admin-only;
// Inventory is open to Regular Users again (they can add/edit products, just
// not view the Dashboard's business-wide sales/profit figures).
const SUPER_ADMIN_ONLY_PAGES = ['dashboard', 'users', 'audit'];
function setPage(page) {
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
        ${isSuperAdmin() ? summaryCard('Total profit', formatMoney(summary.totalProfit), `${summary.profitMargin}% margin \u00b7 selling price minus cost price`) : ''}
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
  const discount = Math.min(Math.max(0, Number(state.discount) || 0), subtotal);
  const grandTotal = Math.max(0, subtotal - discount);
  cart.innerHTML = `<div class="cart-heading"><div><p class="eyebrow">CURRENT SALE</p><h2>Cart</h2></div><span class="cart-count">${items.length} item${items.length === 1 ? '' : 's'}</span></div><div class="cart-items">${items.length ? items.map((item) => { const def = unitDef(item.product.unit); const quantityControl = `<div class="quantity-control${def.fractional ? ' fractional' : ''}">${def.fractional ? '' : `<button type="button" data-quantity="${item.productId}" data-change="-1" aria-label="Decrease quantity">&minus;</button>`}<input type="number" min="${def.fractional ? quantityStep(def) : '1'}" step="${quantityStep(def)}" max="${item.product.stock}" value="${formatQuantity(item.quantity, def.fractional)}" data-quantity-input="${item.productId}">${def.fractional ? `<span class="quantity-unit">${def.shortLabel}</span>` : `<button type="button" data-quantity="${item.productId}" data-change="1" aria-label="Increase quantity">+</button>`}</div>`; return `<article class="cart-item"><div><h3>${escapeHtml(item.product.name)}</h3><p>${formatMoney(item.product.price)} per ${def.shortLabel} &middot; ${formatQuantity(item.product.stock, def.fractional)} in stock</p></div><button class="icon-button remove" data-remove="${item.productId}" title="Remove item">&times;</button><div class="cart-line">${quantityControl}<strong>${formatMoney(item.product.price * item.quantity)}</strong></div></article>`; }).join('') : emptyState('Your cart is empty', 'Click a product card to add it to this sale.')}</div><div class="cart-totals"><div><span>Subtotal</span><strong id="cart-subtotal">${formatMoney(subtotal)}</strong></div><div><span>Items</span><strong>${items.length}</strong></div><div class="discount-row"><span>Discount</span><input id="cart-discount" type="number" min="0" step="0.01" max="${subtotal}" value="${state.discount ? state.discount : ''}" placeholder="0.00" ${items.length ? '' : 'disabled'}></div>${!isSuperAdmin() && items.length ? `<p class="discount-hint">Max discount: ${formatMoney(subtotal * (state.maxRegularUserDiscountPercent / 100))} (${state.maxRegularUserDiscountPercent}% of subtotal)</p>` : ''}<div class="grand-total"><span>Grand total</span><strong id="cart-grand-total">${formatMoney(grandTotal)}</strong></div><button id="complete-sale" class="primary-button wide" ${items.length ? '' : 'disabled'}>Complete Sale</button></div>`;
  cart.querySelectorAll('[data-quantity]').forEach((button) => button.addEventListener('click', () => changeQuantity(button.dataset.quantity, Number(button.dataset.change))));
  // change fires on blur/Enter so a half-typed number (e.g. "1" while typing
  // "12") never gets clamped mid-keystroke; setQuantity() does the validation.
  cart.querySelectorAll('[data-quantity-input]').forEach((input) => {
    input.addEventListener('change', () => setQuantity(input.dataset.quantityInput, Number(input.value)));
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
  });
  cart.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => { state.cart = state.cart.filter((item) => item.productId !== button.dataset.remove); renderCart(); }));
  // Updates state and the grand-total display directly rather than calling
  // renderCart() on every keystroke, so the input never loses focus while typing.
  cart.querySelector('#cart-discount').addEventListener('input', (event) => {
    const raw = Number(event.target.value);
    state.discount = Number.isFinite(raw) && raw >= 0 ? raw : 0;
    const clamped = Math.min(state.discount, subtotal);
    cart.querySelector('#cart-grand-total').textContent = formatMoney(Math.max(0, subtotal - clamped));
  });
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
async function completeSale() { try { const sale = await window.kjStore.completeSale(state.cart, state.discount); state.cart = []; state.discount = 0; await refreshData(); renderSale(); notify(`Sale ${sale.id} completed successfully.`); openSaleCompleteModal(sale); } catch (error) { showError(error); await refreshData(); renderSale(); } }
// Shown right after a sale is saved so the cashier can print a receipt for the
// customer immediately, without hunting for it in History afterward.
function openSaleCompleteModal(sale) {
  openModal(`<div class="modal-header"><div><p class="eyebrow">SALE COMPLETED</p><h2>${escapeHtml(sale.id)}</h2><p>${sale.itemCount} item${sale.itemCount === 1 ? '' : 's'} &middot; Total ${formatMoney(sale.total)}</p></div><button data-close-modal class="icon-button">&times;</button></div><div class="modal-actions"><button type="button" data-close-modal class="secondary-button">Done, no receipt</button><button id="print-now-button" class="primary-button">Print Receipt</button></div>`);
  modalRoot.querySelector('#print-now-button').addEventListener('click', () => printSaleReceipt(sale.id));
}

function renderInventory() {
  const categoryOptions = state.categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
  // Full inventory access for all users now, including bulk CSV Import.
  app.innerHTML = `${pageHeader('CATALOG', 'Inventory', 'Add, edit, and monitor the products you sell.', `<div class="header-actions"><button id="import-inventory" class="secondary-button">Import CSV</button><button id="export-inventory" class="secondary-button">Export CSV</button><button id="add-product" class="primary-button">+ Add New Product</button></div>`)}<section class="panel"><div class="table-filters"><input id="inventory-search" type="search" placeholder="Search product name or SKU"><select id="inventory-category"><option value="">All categories</option>${categoryOptions}</select></div><div id="inventory-table"></div></section>`;
  const resetAndRender = () => { state.inventoryPagination.page = 1; renderInventoryTable(); };
  app.querySelector('#add-product')?.addEventListener('click', () => openProductModal()); app.querySelector('#inventory-search').addEventListener('input', resetAndRender); app.querySelector('#inventory-category').addEventListener('change', resetAndRender); renderInventoryTable();
  app.querySelector('#export-inventory').addEventListener('click', exportInventoryCsv);
  app.querySelector('#import-inventory')?.addEventListener('click', startInventoryImport);
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
  // Cost price and per-unit profit are margin-sensitive, so these columns only
  // render for Super Admins -- Regular Users keep seeing the existing columns.
  // Cost/profit columns are now shown to all users (full inventory access).
  const showProfit = true;
  // Potential profit if every unit of currently-filtered stock sold at its
  // listed price -- computed over the full filtered set, not just this page.
  const profitSummaryBar = showProfit ? (() => {
    const totalProfit = filtered.reduce((sum, product) => sum + (product.stock * (product.price - (product.costPrice || 0))), 0);
    const totalRetailValue = filtered.reduce((sum, product) => sum + (product.stock * product.price), 0);
    const margin = totalRetailValue > 0 ? Math.round((totalProfit / totalRetailValue) * 1000) / 10 : null;
    return `<div class="inventory-profit-summary"><span>Potential profit on ${filtered.length} product${filtered.length === 1 ? '' : 's'} currently in stock</span><strong class="${totalProfit < 0 ? 'profit-negative' : 'profit-positive'}">${formatMoney(totalProfit)}</strong>${margin !== null ? `<small>${margin}% margin</small>` : ''}</div>`;
  })() : '';
  const profitColumns = showProfit ? '<th>Cost</th><th>Profit</th>' : '';
  table.innerHTML = `${profitSummaryBar}<div class="data-table-wrap"><table><thead><tr><th>Product</th><th>Category</th><th>Price</th>${profitColumns}<th>Stock</th><th>Status</th><th aria-label="Actions"></th></tr></thead><tbody>${products.map((product) => { const [label, style] = productStatus(product); const def = unitDef(product.unit); const profitCells = showProfit ? (() => { const profit = product.price - (product.costPrice || 0); const margin = product.price > 0 ? Math.round((profit / product.price) * 1000) / 10 : null; return `<td>${formatMoney(product.costPrice || 0)}</td><td class="${profit < 0 ? 'profit-negative' : 'profit-positive'}">${formatMoney(profit)}${margin !== null ? `<small> (${margin}%)</small>` : ''}</td>`; })() : ''; return `<tr><td><strong>${escapeHtml(product.name)}</strong><small>${product.sku ? `SKU: ${escapeHtml(product.sku)}` : 'No SKU'}</small></td><td>${escapeHtml(product.category)}</td><td>${formatMoney(product.price)} <small>/ ${def.shortLabel}</small></td>${profitCells}<td>${formatQuantity(product.stock, def.fractional)} ${unitShortLabel(product.unit, product.stock)}</td><td><span class="badge ${style}">${label}</span></td><td class="row-actions">${iconActionButton({ name: 'edit', label: 'Edit', attr: `data-edit="${product.id}"` })}${iconActionButton({ name: 'archive', label: 'Archive', attr: `data-archive="${product.id}"`, extraClass: 'danger' })}</td></tr>`; }).join('')}</tbody></table></div>${paginationMarkup(pageState, filtered.length, 'products')}`;
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
    table.innerHTML = `<div class="data-table-wrap"><table><thead><tr><th>Transaction ID</th><th>Date & time</th><th>Processed By</th><th>Items Sold</th><th>Qty</th><th>Discount</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>${sales.map((sale) => { const itemsCell = !sale.items.length ? '&mdash;' : sale.items.length === 1 ? `<span class="history-items-cell">${escapeHtml(sale.items[0].productName)}</span>` : `<span class="history-items-cell">${escapeHtml(sale.items[0].productName)}</span> <button type="button" class="link-button" data-sale-items="${sale.id}">+${sale.items.length - 1} more</button>`; return `<tr><td><strong>${escapeHtml(sale.id)}</strong></td><td>${dateTime.format(new Date(sale.createdAt))}</td><td>${sale.userId ? escapeHtml(userName(sale.userId)) : '&mdash;'}</td><td>${itemsCell}</td><td>${sale.itemCount}</td><td>${sale.discount ? formatMoney(sale.discount) : '&mdash;'}</td><td>${formatMoney(sale.total)}</td><td><span class="badge ${sale.status === 'Voided' ? 'danger' : 'success'}">${sale.status}</span></td><td class="row-actions">${iconActionButton({ name: 'view', label: 'View details', attr: `data-sale-detail="${sale.id}"` })}${iconActionButton({ name: 'printer', label: 'Print Receipt', attr: `data-print-receipt="${sale.id}"` })}${isSuperAdmin() && sale.status !== 'Voided' ? iconActionButton({ name: 'void', label: 'Void Sale', attr: `data-void-sale="${sale.id}"`, extraClass: 'danger' }) : ''}</td></tr>`; }).join('')}</tbody></table></div>${paginationMarkup(pageState, allSales.length, 'transactions')}`;
    table.querySelectorAll('[data-sale-detail]').forEach((button) => button.addEventListener('click', () => openSaleDetail(button.dataset.saleDetail)));
    // "+N more" opens the same item-by-item breakdown as View Details, rather
    // than a second, subtly-different modal to maintain.
    table.querySelectorAll('[data-sale-items]').forEach((button) => button.addEventListener('click', () => openSaleDetail(button.dataset.saleItems)));
    table.querySelectorAll('[data-print-receipt]').forEach((button) => button.addEventListener('click', () => printSaleReceipt(button.dataset.printReceipt)));
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

// ---- Print Receipt: Complete Sale -> Print Receipt -> Preview -> Print ----
//
// The preview modal renders the exact HTML that would be sent to the printer
// (fetched from the main process, same buildReceiptHtml() used for printing),
// inside a sandboxed iframe sized to the chosen paper width, so what's shown
// on screen is a true WYSIWYG match -- no separate preview-only layout to
// keep in sync. Printing itself always goes through Electron's native
// print dialog (silent: false in main.js), so any installed Windows printer
// -- including "Microsoft Print to PDF" -- works for testing without a
// physical thermal printer.
function openReceiptPreviewModal(saleId) {
  let currentWidth = state.receiptPaperWidth || '80mm';
  openModal(`<div class="modal-header"><div><p class="eyebrow">RECEIPT PREVIEW</p><h2>${escapeHtml(saleId)}</h2><p>Choose a paper width and printer, then print.</p></div><button data-close-modal class="icon-button">&times;</button></div>
    <div class="receipt-preview-toolbar"><div class="paper-toggle" role="group" aria-label="Receipt paper width"><button type="button" class="paper-toggle-btn" data-paper-width="58mm">58mm</button><button type="button" class="paper-toggle-btn" data-paper-width="80mm">80mm</button></div></div>
    <div class="receipt-printer-row"><label for="receipt-printer-select">Printer</label><select id="receipt-printer-select" disabled><option>Detecting printers...</option></select></div>
    <div class="receipt-layout-row"><span>Margins (lines)</span><label>Top<input type="number" min="0" max="10" step="1" data-layout="receiptTopMarginLines"></label><label>Bottom<input type="number" min="0" max="20" step="1" data-layout="receiptBottomMarginLines"></label><label>Left (chars)<input type="number" min="0" max="6" step="1" data-layout="receiptLeftMarginChars"></label><label>Min length<input type="number" min="0" max="80" step="1" data-layout="receiptMinLines"></label></div>
    <div class="receipt-preview-frame-wrap"><iframe id="receipt-preview-frame" class="receipt-preview-frame" title="Receipt preview" sandbox="allow-same-origin"></iframe></div>
    <div id="receipt-preview-error"></div>
    <div class="modal-actions"><button type="button" data-close-modal class="secondary-button">Close</button><button id="receipt-print-button" class="primary-button">Print</button></div>`);

  const frame = modalRoot.querySelector('#receipt-preview-frame');
  const errorBox = modalRoot.querySelector('#receipt-preview-error');
  const printButton = modalRoot.querySelector('#receipt-print-button');
  const printerSelect = modalRoot.querySelector('#receipt-printer-select');
  const SYSTEM_DIALOG = '__system-dialog__';

  // Detects installed Windows printers and pre-selects the saved one, or a
  // thermal-looking (e.g. POS-58) printer, or the Windows default.
  async function loadPrinters() {
    try {
      const { printers, selected } = await window.kjStore.listPrinters();
      const options = printers.map((printer) => `<option value="${escapeHtml(printer.name)}">${escapeHtml(printer.displayName)}${printer.isDefault ? ' (default)' : ''}${printer.looksThermal ? ' \u2014 thermal' : ''}</option>`);
      options.push(`<option value="${SYSTEM_DIALOG}">Choose in Windows print dialog...</option>`);
      printerSelect.innerHTML = options.join('');
      printerSelect.value = [...printerSelect.options].some((option) => option.value === selected) ? selected : (printers[0]?.name || SYSTEM_DIALOG);
      printerSelect.disabled = false;
      if (!printers.length) errorBox.innerHTML = '<p class="form-error">No printers were found. Install your thermal printer in Windows, then reopen this window.</p>';
    } catch (error) {
      printerSelect.innerHTML = `<option value="${SYSTEM_DIALOG}">Choose in Windows print dialog...</option>`;
      printerSelect.disabled = false;
      errorBox.innerHTML = `<p class="form-error">${escapeHtml(error?.message || 'Could not detect printers.')}</p>`;
    }
  }
  // Receipt margins / minimum length: saved as defaults and re-rendered in the
  // preview as soon as a value changes.
  window.kjStore.getSettings().then((settings) => {
    modalRoot.querySelectorAll('[data-layout]').forEach((input) => { input.value = settings[input.dataset.layout] ?? ''; });
  }).catch(() => {});
  modalRoot.querySelectorAll('[data-layout]').forEach((input) => input.addEventListener('change', async () => {
    try {
      await window.kjStore.updateSettings({ [input.dataset.layout]: Number(input.value) });
      loadPreview();
    } catch (error) { showError(error); window.kjStore.getSettings().then((settings) => { input.value = settings[input.dataset.layout] ?? ''; }).catch(() => {}); }
  }));
  printerSelect.addEventListener('change', () => { window.kjStore.updateSettings({ receiptPrinterName: printerSelect.value }).catch(() => {}); });

  function setActiveToggle() {
    modalRoot.querySelectorAll('[data-paper-width]').forEach((btn) => btn.classList.toggle('active', btn.dataset.paperWidth === currentWidth));
    frame.style.width = currentWidth === '58mm' ? '219px' : '302px'; // ~mm-to-px at 96dpi, matches the printed @page size
  }
  async function loadPreview() {
    setActiveToggle();
    errorBox.innerHTML = '';
    try {
      const html = await window.kjStore.getReceiptPreview(saleId, currentWidth);
      frame.srcdoc = html;
    } catch (error) {
      errorBox.innerHTML = `<p class="form-error">${escapeHtml(error?.message || 'Could not load the receipt preview.')}</p>`;
    }
  }
  // Auto-fits the iframe's height to the receipt's actual content (item count
  // varies per sale) instead of a fixed guess, capped so a long receipt
  // scrolls inside the preview rather than pushing the modal off-screen.
  frame.addEventListener('load', () => {
    try {
      const contentHeight = Math.ceil(frame.contentDocument.body.getBoundingClientRect().height);
      frame.style.height = `${Math.min(contentHeight + 4, Math.round(window.innerHeight * 0.6))}px`;
    } catch { /* preview still shows even if auto-height can't be measured */ }
  });

  modalRoot.querySelectorAll('[data-paper-width]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.paperWidth === currentWidth) return;
    currentWidth = button.dataset.paperWidth;
    state.receiptPaperWidth = currentWidth; // remembered as the default for next time
    window.kjStore.updateSettings({ receiptPaperWidth: currentWidth }).catch(() => {});
    loadPreview();
  }));
  printButton.addEventListener('click', async () => {
    if (printButton.disabled) return;
    printButton.disabled = true;
    const originalLabel = printButton.textContent;
    printButton.textContent = 'Printing...';
    try {
      const result = await window.kjStore.printReceipt(saleId, currentWidth, printerSelect.value);
      if (result.printed) { notify(result.printer ? `Receipt sent to ${result.printer}.` : 'Receipt sent to the printer.'); closeModal(); return; }
      if (!result.cancelled) {
        errorBox.innerHTML = `<p class="form-error">${escapeHtml(result.reason || 'The receipt could not be printed.')}</p>`;
        notify('Could not print the receipt.', 'error');
      }
    } catch (error) { showError(error); } finally { printButton.disabled = false; printButton.textContent = originalLabel; }
  });

  loadPrinters();
  loadPreview();
}
// History's "Print Receipt" action and the post-sale prompt both funnel
// through the same preview modal, so a fresh sale and a historical one print
// identically.
function printSaleReceipt(saleId) { openReceiptPreviewModal(saleId); }

function render() {
  if (SUPER_ADMIN_ONLY_PAGES.includes(state.page) && !isSuperAdmin()) {
    state.page = 'sale';
    document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === 'sale'));
  }
  if (state.page === 'dashboard') renderDashboard();
  else if (state.page === 'sale') renderSale();
  else if (state.page === 'inventory') renderInventory();
  else if (state.page === 'users') renderUsers();
  else if (state.page === 'audit') renderAuditLog();
  else renderHistory();
}
function closeModal() { modalRoot.innerHTML = ''; }
function openModal(content) { modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true">${content}</section></div>`; modalRoot.querySelector('.modal-backdrop').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeModal(); }); modalRoot.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', closeModal)); }
function openProductModal(product = null) {
  const title = product ? 'Edit Product' : 'Add New Product'; const categoryOptions = state.categories.map((category) => `<option value="${escapeHtml(category)}" ${product?.category === category ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('');
  const selectedUnit = product?.unit || 'piece';
  const unitOptions = state.units.map((unit) => `<option value="${unit.value}" ${selectedUnit === unit.value ? 'selected' : ''}>${escapeHtml(unit.label)}</option>`).join('');
  const startingDef = unitDef(selectedUnit);
  // Cost price is now visible/editable by all users, same as the rest of
  // Inventory (client decision: full inventory access for Regular Users).
  const costField = `<label>Cost price (what you paid)<input name="costPrice" id="product-cost" type="number" min="0" step="0.01" value="${product?.costPrice ?? ''}" placeholder="0.00"></label>`;
  const profitHint = `<p class="unit-hint full" id="profit-hint">${profitHintText(product?.costPrice, product?.price)}</p>`;
  openModal(`<div class="modal-header"><div><h2>${title}</h2><p>Enter the product details below.</p></div><button data-close-modal class="icon-button">&times;</button></div><form id="product-form"><div class="form-grid"><label class="full">Product name<input name="name" required maxlength="100" value="${escapeHtml(product?.name || '')}"></label><label>SKU / barcode<input name="sku" maxlength="80" value="${escapeHtml(product?.sku || '')}"></label><label>Category<select name="category" required><option value="">Choose category</option>${categoryOptions}</select></label><label>Unit of measurement<select name="unit" id="product-unit">${unitOptions}</select></label>${costField}<label>Selling price<input name="price" id="product-price" type="number" min="0" step="0.01" required value="${product?.price ?? ''}"></label><label>Stock quantity<input name="stock" id="product-stock" type="number" min="0" step="${quantityStep(startingDef)}" required value="${product?.stock ?? ''}"></label><label>Low-stock level<input name="lowStockThreshold" id="product-low-stock" type="number" min="0" step="${quantityStep(startingDef)}" required value="${product?.lowStockThreshold ?? 5}"></label><p class="unit-hint full" id="unit-hint">${unitHintText(startingDef)}</p>${profitHint}</div><div class="modal-actions"><button type="button" data-close-modal class="secondary-button">Cancel</button><button class="primary-button">${product ? 'Save Changes' : 'Add Product'}</button></div></form>`);
  modalRoot.querySelector('#product-unit').addEventListener('change', (event) => {
    const def = unitDef(event.target.value);
    modalRoot.querySelector('#product-stock').step = quantityStep(def);
    modalRoot.querySelector('#product-low-stock').step = quantityStep(def);
    modalRoot.querySelector('#unit-hint').innerHTML = unitHintText(def);
  });
  {
    const updateProfitHint = () => {
      const costPrice = modalRoot.querySelector('#product-cost').value;
      const price = modalRoot.querySelector('#product-price').value;
      const hint = modalRoot.querySelector('#profit-hint');
      if (hint) hint.innerHTML = profitHintText(costPrice, price);
    };
    modalRoot.querySelector('#product-cost').addEventListener('input', updateProfitHint);
    modalRoot.querySelector('#product-price').addEventListener('input', updateProfitHint);
  }
  modalRoot.querySelector('#product-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const input = Object.fromEntries(form.entries()); try { if (product) await window.kjStore.updateProduct(product.id, input); else await window.kjStore.createProduct(input); await refreshData(); closeModal(); renderInventory(); notify(product ? 'Product updated.' : 'Product added to inventory.'); } catch (error) { showError(error); } });
}
// Live "you paid X, you sell for Y" profit preview shown to Super Admins while
// editing a product. Renders a neutral hint until both prices are entered.
function profitHintText(costPrice, price) {
  const cost = Number(costPrice); const sell = Number(price);
  if (!Number.isFinite(cost) || !Number.isFinite(sell) || costPrice === '' || costPrice === undefined || price === '' || price === undefined) {
    return 'Enter both cost price and selling price to see the profit per unit.';
  }
  const profit = sell - cost;
  const margin = sell > 0 ? Math.round((profit / sell) * 1000) / 10 : null;
  const verdict = profit > 0 ? 'profit' : profit < 0 ? 'loss' : 'break-even';
  return `Profit per unit: <strong>${formatMoney(Math.abs(profit))} ${verdict}</strong>${margin !== null ? ` (${margin}% margin)` : ''}`;
}
function unitHintText(def) {
  if (!def.fractional) return `Stocked and sold by the whole ${def.label.toLowerCase()}.`;
  if (def.value === 'load') return `Stocked and sold by the dump-truck load. Enter <strong>0.5</strong> for a half load, <strong>0.25</strong> for a quarter load, or <strong>1</strong> for a full load.`;
  return `Stocked and sold in ${def.label.toLowerCase()}. Buying in bulk (e.g. a 50kg sack)? Add its total in ${def.shortLabel} \u2014 for a 50kg sack, enter <strong>50</strong>.`;
}
function confirmArchive(productId) { const product = activeProducts().find((item) => item.id === productId); openModal(`<div class="modal-header"><div><h2>Archive product?</h2><p>${escapeHtml(product.name)} will no longer be available to sell. Historical sales remain intact.</p></div><button data-close-modal class="icon-button">&times;</button></div><div class="modal-actions"><button data-close-modal class="secondary-button">Cancel</button><button id="confirm-archive" class="danger-button">Archive Product</button></div>`); modalRoot.querySelector('#confirm-archive').addEventListener('click', async () => { try { await window.kjStore.archiveProduct(productId); await refreshData(); closeModal(); renderInventory(); notify('Product archived.'); } catch (error) { showError(error); } }); }
async function openSaleDetail(id) { try { const sale = await window.kjStore.getSale(id); const subtotal = sale.subtotal ?? sale.total; const discount = sale.discount ?? 0; openModal(`<div class="modal-header"><div><p class="eyebrow">TRANSACTION</p><h2>${escapeHtml(sale.id)} ${sale.status === 'Voided' ? '<span class="badge danger">Voided</span>' : ''}</h2><p>${dateTime.format(new Date(sale.createdAt))} &middot; Processed By: ${sale.userId ? escapeHtml(userName(sale.userId)) : 'Unknown user'}</p></div><button data-close-modal class="icon-button">&times;</button></div>${sale.status === 'Voided' ? `<div class="void-notice"><strong>Voided</strong> ${dateTime.format(new Date(sale.voidedAt))} by ${escapeHtml(userName(sale.voidedBy))}<br>Reason: ${escapeHtml(sale.voidReason)}</div>` : ''}<div class="receipt-items">${sale.items.map((item) => { const def = unitDef(item.unit); return `<div><div><strong>${escapeHtml(item.productName)}</strong><small>${formatQuantity(item.quantity, def.fractional)} ${unitShortLabel(item.unit, item.quantity)} &times; ${formatMoney(item.unitPrice)}</small></div><strong>${formatMoney(item.subtotal)}</strong></div>`; }).join('')}</div><div class="receipt-subline"><span>Subtotal (${sale.itemCount} items)</span><strong>${formatMoney(subtotal)}</strong></div><div class="receipt-subline"><span>Discount</span><strong>${discount ? `-${formatMoney(discount)}` : formatMoney(0)}</strong></div><div class="receipt-total"><span>Total</span><strong>${formatMoney(sale.total)}</strong></div><div class="modal-actions"><button data-close-modal class="secondary-button">Close</button></div>`); } catch (error) { showError(error); } }

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

// ---- Audit Log (Super Admin only) ----
// Read-only trail of sensitive actions (price/cost changes, manual stock
// adjustments, sales, voids, discounts, user/role changes) so a Super Admin
// can spot the "lowered a price, rang up a sale, restored the price" pattern
// or any other manipulation after the fact.
const AUDIT_ACTION_LABELS = {
  'Selling price changed': 'danger',
  'Cost price changed': 'danger',
  'Inventory manually adjusted': 'danger',
  'Product archived': 'danger',
  'Sale voided': 'danger',
  'User role changed': 'danger',
  'Discount applied': 'success',
  'Sale completed': 'success',
  'User created': 'success',
  'User account modified': 'success'
};
function auditValueDisplay(entry) {
  if (entry.field === 'price' || entry.field === 'costPrice' || entry.field === 'stock') {
    const isMoney = entry.field !== 'stock';
    const fmt = (v) => v === null || v === undefined ? '\u2014' : (isMoney ? formatMoney(v) : v);
    return `${fmt(entry.before)} &rarr; ${fmt(entry.after)}`;
  }
  if (entry.field === 'discount' || entry.field === 'total') return formatMoney(entry.after);
  if (entry.before === null || entry.before === undefined) return escapeHtml(String(entry.after ?? '\u2014'));
  return `${escapeHtml(String(entry.before))} &rarr; ${escapeHtml(String(entry.after))}`;
}
async function renderAuditLog() {
  app.innerHTML = `${pageHeader('SECURITY', 'Audit Log', 'A record of price, inventory, sales, and account changes across the system.')}
    <section class="panel discount-policy-panel">
      <div>
        <h3>Regular User discount limit</h3>
        <p>The maximum discount a Regular User (Cashier) can apply to a sale, as a percentage of the subtotal. Super Admins are never limited.</p>
      </div>
      <form id="discount-policy-form"><label>Max discount %<input id="discount-policy-input" type="number" min="0" max="100" step="1" value=""></label><button class="primary-button" type="submit">Save</button></form>
    </section>
    <section class="panel"><div id="audit-table" class="loading">Loading audit log...</div></section>`;

  try {
    const settings = await window.kjStore.getSettings();
    app.querySelector('#discount-policy-input').value = settings.maxRegularUserDiscountPercent ?? 20;
  } catch (error) { showError(error); }
  app.querySelector('#discount-policy-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = Number(app.querySelector('#discount-policy-input').value);
    try {
      await window.kjStore.updateSettings({ maxRegularUserDiscountPercent: value });
      notify('Discount limit updated.');
    } catch (error) { showError(error); }
  });

  await renderAuditTable();
}
async function renderAuditTable() {
  const table = app.querySelector('#audit-table');
  try {
    const entries = await window.kjStore.getAuditLog();
    if (!entries.length) { table.innerHTML = emptyState('No activity yet', 'Sensitive actions (price changes, sales, voids, account changes) will show up here.'); return; }
    const pageState = state.auditPagination;
    const rows = paginate(entries, pageState);
    table.innerHTML = `<div class="data-table-wrap"><table><thead><tr><th>Date & time</th><th>User</th><th>Action</th><th>Affected record</th><th>Change</th></tr></thead><tbody>${rows.map((entry) => `<tr><td>${dateTime.format(new Date(entry.at))}</td><td>${entry.userId ? escapeHtml(userName(entry.userId)) : '&mdash;'}</td><td><span class="badge ${AUDIT_ACTION_LABELS[entry.action] || 'success'}">${escapeHtml(entry.action)}</span></td><td>${escapeHtml(entry.target || '\u2014')}</td><td>${auditValueDisplay(entry)}${entry.note ? `<br><small>${escapeHtml(entry.note)}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>${paginationMarkup(pageState, entries.length, 'entries')}`;
    bindPagination(table, pageState, renderAuditTable);
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
