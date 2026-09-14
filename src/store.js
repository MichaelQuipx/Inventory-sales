const fs = require('fs');
const path = require('path');
const { randomUUID, randomBytes, scryptSync, timingSafeEqual } = require('crypto');
const { parseCsvRecords } = require('./csv');

const CATEGORIES = ['Hardware', 'Motorparts', 'Rice', 'Hog & Chicken Feeds'];

// Each product is stocked AND sold in exactly one of these units (Option A from
// the design discussion: no per-sale unit conversion, no rounding drift from
// converting sacks<->kg on every transaction). "Whole" units (piece, pack, box,
// sack) must always be sold/stocked in integer amounts. "Fractional" units
// (kg, g, liter, ml) may be stocked and sold in decimal amounts, so a product
// stocked by the sack but sold by the kg should simply use unit "kg" and be
// restocked with the sack's total weight (e.g. +50 when a 50kg sack arrives).
const UNITS = [
  { value: 'piece', label: 'Piece', shortLabel: 'pc', shortLabelPlural: 'pcs', fractional: false },
  { value: 'pack', label: 'Pack', shortLabel: 'pack', shortLabelPlural: 'packs', fractional: false },
  { value: 'box', label: 'Box', shortLabel: 'box', shortLabelPlural: 'boxes', fractional: false },
  { value: 'sack', label: 'Sack', shortLabel: 'sack', shortLabelPlural: 'sacks', fractional: false },
  { value: 'kg', label: 'Kilogram (kg)', shortLabel: 'kg', shortLabelPlural: 'kg', fractional: true },
  { value: 'g', label: 'Gram (g)', shortLabel: 'g', shortLabelPlural: 'g', fractional: true },
  { value: 'liter', label: 'Liter (L)', shortLabel: 'L', shortLabelPlural: 'L', fractional: true },
  { value: 'ml', label: 'Milliliter (mL)', shortLabel: 'mL', shortLabelPlural: 'mL', fractional: true }
];
const UNIT_MAP = new Map(UNITS.map((unit) => [unit.value, unit]));
const DEFAULT_UNIT = 'piece';

// Keeps fractional stock/quantities from drifting through repeated floating-point
// arithmetic (e.g. 50 - 2 - 2 - ... should never end up as 45.999999999998).
function roundQuantity(value) {
  return Math.round(value * 1000) / 1000;
}

class StoreError extends Error {}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyDatabase() {
  return { version: 2, users: [], products: [], sales: [], session: null };
}

function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function passwordMatches(password, storedHash) {
  const [salt, hash] = String(storedHash || '').split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function defaultSuperAdmin() {
  const now = new Date().toISOString();
  return { id: 'kj-initial-super-admin', name: 'KJ Store Admin', username: 'admin', passwordHash: passwordHash('Admin123!'), role: 'super-admin', active: true, createdAt: now, updatedAt: now, lastLoginAt: null };
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

function demoDatabase() {
  const now = new Date();
  const productRows = [
    ['Galvanized Nails', 'HW-001', 'Hardware', 45.5, 120, 15],
    ['PVC Pipe 1 inch', 'HW-002', 'Hardware', 180, 30, 5],
    ['Claw Hammer', 'HW-003', 'Hardware', 285, 24, 4],
    ['Engine Oil 1L', 'MP-001', 'Motorparts', 320, 20, 4],
    ['Spark Plug', 'MP-002', 'Motorparts', 145, 40, 8],
    ['Motorcycle Chain', 'MP-003', 'Motorparts', 580, 15, 3],
    ['Premium Rice 5kg', 'RC-001', 'Rice', 315, 80, 12],
    ['Jasmine Rice 5kg', 'RC-002', 'Rice', 360, 45, 8],
    ['Chicken Starter Mash 25kg', 'FD-001', 'Hog & Chicken Feeds', 1120, 35, 6],
    ['Hog Grower Pellets 25kg', 'FD-002', 'Hog & Chicken Feeds', 980, 40, 6]
  ];
  const products = productRows.map(([name, sku, category, price, stock, lowStockThreshold], index) => ({
    id: `demo-product-${index + 1}`,
    name,
    sku,
    category,
    price,
    stock,
    lowStockThreshold,
    archived: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  }));
  const bySku = new Map(products.map((product) => [product.sku, product]));
  const saleRows = [
    { daysAgo: 6, items: [['HW-001', 3], ['MP-002', 2], ['FD-001', 4]] },
    { daysAgo: 4, items: [['RC-001', 5], ['FD-002', 3]] },
    { daysAgo: 2, items: [['HW-003', 2], ['MP-003', 1]] },
    { daysAgo: 1, items: [['HW-002', 4], ['FD-001', 2]] },
    { daysAgo: 0, items: [['HW-001', 2], ['MP-001', 1], ['RC-001', 2]] }
  ];
  const sales = saleRows.map((row, index) => {
    const createdAt = new Date(now);
    createdAt.setDate(now.getDate() - row.daysAgo);
    createdAt.setHours(10 + index, 30, 0, 0);
    const items = row.items.map(([sku, quantity]) => {
      const product = bySku.get(sku);
      product.stock -= quantity;
      return { productId: product.id, productName: product.name, category: product.category, sku: product.sku, unitPrice: product.price, quantity, subtotal: product.price * quantity };
    });
    const total = items.reduce((sum, item) => sum + item.subtotal, 0);
    return { id: `KJ-DEMO-${String(index + 1).padStart(3, '0')}`, createdAt: createdAt.toISOString(), status: 'Completed', itemCount: items.reduce((sum, item) => sum + item.quantity, 0), total, items };
  }).reverse();
  return { version: 1, products, sales };
}

function createStore(databasePath) {
  function read() {
    if (!fs.existsSync(databasePath)) return emptyDatabase();
    try {
      const data = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
      if (!Array.isArray(data.products) || !Array.isArray(data.sales)) throw new Error('Invalid data');
      return data;
    } catch {
      throw new StoreError('KJ STORE data could not be read. Your data file was not changed.');
    }
  }

  function write(data) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const temporaryPath = `${databasePath}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temporaryPath, databasePath);
  }

  // ---- Sales archiving ----
  //
  // The whole database is one JSON file, fully read+parsed on every operation
  // and fully rewritten on every write. That cost grows with total file size,
  // not with how much data a given screen actually needs. Archiving moves old
  // sales into separate files, one per calendar year, so:
  //  - day-to-day operations (which only ever touch recent data) never read
  //    archived years at all, keeping the "hot" file -- and therefore every
  //    read/write in the app -- small regardless of how much history exists.
  //  - a query that explicitly needs old data (a custom date range, a report,
  //    an "include archived" search) only opens the specific year files that
  //    range overlaps, not the entire archive.
  // Sale records are self-contained snapshots (product name/price/etc. are
  // copied at sale time), so an archived sale never needs to look anything up
  // from the live product list to be displayed correctly.
  function archiveFilePath(year) {
    const directory = path.dirname(databasePath);
    const base = path.basename(databasePath, '.json');
    return path.join(directory, `${base}-archive-${year}.json`);
  }
  function listArchiveYears() {
    const directory = path.dirname(databasePath);
    const base = path.basename(databasePath, '.json');
    const prefix = `${base}-archive-`;
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .map((name) => Number(name.slice(prefix.length, -'.json'.length)))
      .filter((year) => Number.isInteger(year))
      .sort((a, b) => a - b);
  }
  function readArchiveYear(year) {
    const file = archiveFilePath(year);
    if (!fs.existsSync(file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed.sales) ? parsed.sales : [];
    } catch {
      throw new StoreError(`Archived sales for ${year} could not be read. That archive file was not changed.`);
    }
  }
  function writeArchiveYear(year, sales) {
    const file = archiveFilePath(year);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporaryPath = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, year, sales }, null, 2), 'utf8');
    fs.renameSync(temporaryPath, file);
  }
  function yearsBetween(start, end) {
    const years = [];
    for (let year = start.getFullYear(); year <= new Date(end.getTime() - 1).getFullYear(); year += 1) years.push(year);
    return years;
  }
  function dedupeSales(sales) {
    const seen = new Set();
    return sales.filter((sale) => { if (seen.has(sale.id)) return false; seen.add(sale.id); return true; });
  }
  // The pool of sales relevant to a query: always the hot file, plus any
  // archive years that overlap [start, end) when a range is given, plus every
  // archive year when includeArchived is explicitly requested with no range.
  function collectSales(data, { start, end, includeArchived = false } = {}) {
    let pool = data.sales;
    if (start && end) {
      pool = pool.concat(yearsBetween(start, end).flatMap((year) => readArchiveYear(year)));
    } else if (includeArchived) {
      pool = pool.concat(listArchiveYears().flatMap((year) => readArchiveYear(year)));
    }
    return dedupeSales(pool);
  }
  function archiveSummary() {
    const years = listArchiveYears();
    return years.map((year) => ({ year, count: readArchiveYear(year).length }));
  }
  // Moves every sale completed before `cutoffIso` out of the hot file and into
  // the appropriate year archive(s). Archive files are written FIRST and the
  // (now smaller) hot file last: if anything fails partway through, the worst
  // case is a sale temporarily existing in both places (harmless -- dedupeSales
  // and re-archiving both tolerate that), never a sale disappearing entirely.
  function archiveSalesBefore(cutoffIso) {
    const cutoff = new Date(cutoffIso);
    if (Number.isNaN(cutoff.getTime())) throw new StoreError('Choose a valid cutoff date.');
    const data = read();
    const toArchive = data.sales.filter((sale) => new Date(sale.createdAt).getTime() < cutoff.getTime());
    if (!toArchive.length) return { archivedCount: 0, years: [], remaining: data.sales.length };

    const byYear = new Map();
    for (const sale of toArchive) {
      const year = new Date(sale.createdAt).getFullYear();
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push(sale);
    }
    const archivedIds = new Set(toArchive.map((sale) => sale.id));
    for (const [year, salesForYear] of byYear) {
      const merged = dedupeSales([...readArchiveYear(year), ...salesForYear]).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      writeArchiveYear(year, merged);
    }
    data.sales = data.sales.filter((sale) => !archivedIds.has(sale.id));
    write(data);
    return { archivedCount: toArchive.length, years: [...byYear.keys()].sort((a, b) => a - b), remaining: data.sales.length };
  }

  function migrate(data) {
    let changed = false;
    if (!Array.isArray(data.users)) { data.users = []; changed = true; }
    if (data.users.length === 0) { data.users.push(defaultSuperAdmin()); changed = true; }
    if (data.session === undefined) { data.session = null; changed = true; }
    if (Array.isArray(data.products)) {
      for (const product of data.products) {
        if (!product.unit || !UNIT_MAP.has(product.unit)) { product.unit = DEFAULT_UNIT; changed = true; }
        if (typeof product.costPrice !== 'number') { product.costPrice = 0; changed = true; }
      }
    }
    if (data.version !== 2) { data.version = 2; changed = true; }
    return changed;
  }

  function initialize() {
    const data = read();
    if (migrate(data)) write(data);
  }

  function cleanUser(input, existing = null) {
    const name = String(input.name || '').trim();
    const username = String(input.username || '').trim().toLowerCase();
    const role = String(input.role || 'regular-user');
    const active = input.active === undefined ? true : !(input.active === false || input.active === 'false');
    if (!name || name.length > 80) throw new StoreError('Enter a full name of up to 80 characters.');
    if (!/^[a-z0-9._@-]{3,100}$/.test(username)) throw new StoreError('Enter a valid username or email address.');
    if (!['super-admin', 'regular-user'].includes(role)) throw new StoreError('Choose a valid user role.');
    const password = String(input.password || '');
    if (!existing && password.length < 8) throw new StoreError('Password must contain at least 8 characters.');
    if (existing && password && password.length < 8) throw new StoreError('Password must contain at least 8 characters.');
    return { name, username, role, active, password };
  }

  function activeSuperAdminCount(data, excludingId = null) {
    return data.users.filter((user) => user.id !== excludingId && user.active && user.role === 'super-admin').length;
  }

  function getUser(id) {
    return publicUser(read().users.find((user) => user.id === id));
  }

  function authenticate(username, password) {
    const data = read();
    const user = data.users.find((candidate) => candidate.username === String(username || '').trim().toLowerCase());
    if (!user || !user.active || !passwordMatches(String(password || ''), user.passwordHash)) throw new StoreError('Invalid username or password.');
    user.lastLoginAt = new Date().toISOString();
    user.updatedAt = user.lastLoginAt;
    data.session = { userId: user.id };
    write(data);
    return publicUser(user);
  }

  // Remembers the signed-in user across app restarts. Returns null if no one
  // is signed in, or if the remembered account no longer exists or was deactivated.
  function getSession() {
    const data = read();
    if (!data.session || !data.session.userId) return null;
    const user = data.users.find((candidate) => candidate.id === data.session.userId);
    if (!user || !user.active) return null;
    return publicUser(user);
  }

  function clearSession() {
    const data = read();
    data.session = null;
    write(data);
  }

  function listUsers() {
    return read().users.map(publicUser).sort((a, b) => a.name.localeCompare(b.name));
  }

  function createUser(input) {
    const data = read();
    const user = cleanUser(input);
    if (data.users.some((candidate) => candidate.username === user.username)) throw new StoreError('That username or email is already in use.');
    const now = new Date().toISOString();
    const saved = { id: randomUUID(), name: user.name, username: user.username, passwordHash: passwordHash(user.password), role: user.role, active: user.active, createdAt: now, updatedAt: now, lastLoginAt: null };
    data.users.push(saved);
    write(data);
    return publicUser(saved);
  }

  function updateUser(id, input) {
    const data = read();
    const existing = data.users.find((user) => user.id === id);
    if (!existing) throw new StoreError('This user no longer exists.');
    const changes = cleanUser(input, existing);
    if (data.users.some((candidate) => candidate.id !== id && candidate.username === changes.username)) throw new StoreError('That username or email is already in use.');
    const wouldRemoveLastAdmin = existing.role === 'super-admin' && existing.active && (!changes.active || changes.role !== 'super-admin') && activeSuperAdminCount(data, id) === 0;
    if (wouldRemoveLastAdmin) throw new StoreError('Keep at least one active Super Admin account.');
    Object.assign(existing, { name: changes.name, username: changes.username, role: changes.role, active: changes.active, updatedAt: new Date().toISOString() });
    if (changes.password) existing.passwordHash = passwordHash(changes.password);
    write(data);
    return publicUser(existing);
  }

  function cleanProduct(input) {
    const name = String(input.name || '').trim();
    const sku = String(input.sku || '').trim();
    const category = String(input.category || '').trim();
    const price = Number(input.price);
    const costPrice = Number(input.costPrice ?? 0);
    const unit = String(input.unit || DEFAULT_UNIT).trim().toLowerCase();
    const stock = Number(input.stock);
    const lowStockThreshold = Number(input.lowStockThreshold ?? 5);

    if (!name || name.length > 100) throw new StoreError('Enter a product name of up to 100 characters.');
    if (!CATEGORIES.includes(category)) throw new StoreError('Choose a valid product category.');
    if (!Number.isFinite(price) || price < 0) throw new StoreError('Selling price must be zero or greater.');
    if (!Number.isFinite(costPrice) || costPrice < 0) throw new StoreError('Cost price must be zero or greater.');
    if (!UNIT_MAP.has(unit)) throw new StoreError('Choose a valid unit of measurement.');
    const unitDefinition = UNIT_MAP.get(unit);
    if (unitDefinition.fractional) {
      if (!Number.isFinite(stock) || stock < 0) throw new StoreError(`Stock quantity must be zero or greater (in ${unitDefinition.label.toLowerCase()}).`);
      if (!Number.isFinite(lowStockThreshold) || lowStockThreshold < 0) throw new StoreError(`Low-stock level must be zero or greater (in ${unitDefinition.label.toLowerCase()}).`);
    } else {
      if (!Number.isInteger(stock) || stock < 0) throw new StoreError(`Stock quantity must be a whole number of ${unitDefinition.label.toLowerCase()}s, zero or greater.`);
      if (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 0) throw new StoreError(`Low-stock level must be a whole number of ${unitDefinition.label.toLowerCase()}s, zero or greater.`);
    }
    return { name, sku, category, price, costPrice: Number(costPrice.toFixed(2)), unit, stock: unitDefinition.fractional ? roundQuantity(stock) : stock, lowStockThreshold: unitDefinition.fractional ? roundQuantity(lowStockThreshold) : lowStockThreshold };
  }

  function getData() {
    const data = read();
    return clone({ version: data.version, products: data.products, sales: data.sales });
  }

  function seedDemoData() {
    const data = read();
    if (data.products.length || data.sales.length) return false;
    const demo = demoDatabase();
    demo.version = data.version;
    demo.users = data.users || [];
    demo.session = data.session || null;
    write(demo);
    return true;
  }

  function createProduct(input) {
    const data = read();
    const product = cleanProduct(input);
    if (product.sku && data.products.some((item) => item.sku.toLowerCase() === product.sku.toLowerCase())) {
      throw new StoreError('That SKU is already being used by another product.');
    }
    const now = new Date().toISOString();
    const saved = { id: randomUUID(), ...product, archived: false, createdAt: now, updatedAt: now };
    data.products.push(saved);
    write(data);
    return clone(saved);
  }

  function updateProduct(id, input) {
    const data = read();
    const product = data.products.find((item) => item.id === id);
    if (!product) throw new StoreError('This product no longer exists.');
    const changes = cleanProduct(input);
    if (changes.sku && data.products.some((item) => item.id !== id && item.sku.toLowerCase() === changes.sku.toLowerCase())) {
      throw new StoreError('That SKU is already being used by another product.');
    }
    Object.assign(product, changes, { updatedAt: new Date().toISOString() });
    write(data);
    return clone(product);
  }

  function archiveProduct(id) {
    const data = read();
    const product = data.products.find((item) => item.id === id);
    if (!product) throw new StoreError('This product no longer exists.');
    product.archived = true;
    product.updatedAt = new Date().toISOString();
    write(data);
  }

  function completeSale(rawItems, userId) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) throw new StoreError('Add at least one product before completing the sale.');
    const data = read();
    const user = data.users.find((candidate) => candidate.id === userId && candidate.active);
    if (!user) throw new StoreError('Your session is no longer active. Please sign in again.');
    const quantities = new Map();
    for (const item of rawItems) {
      const quantity = Number(item.quantity);
      // A product's own unit decides whether fractions are allowed; that isn't
      // known yet for a brand-new productId, so only a generic positive-number
      // check happens here. The whole-vs-fractional check happens below, once
      // each product (and its unit) has been looked up.
      if (!item.productId || !Number.isFinite(quantity) || quantity <= 0) throw new StoreError('Each sale item needs a valid quantity.');
      quantities.set(item.productId, roundQuantity((quantities.get(item.productId) || 0) + quantity));
    }

    const items = [];
    for (const [productId, rawQuantity] of quantities) {
      const product = data.products.find((item) => item.id === productId && !item.archived);
      if (!product) throw new StoreError('One of the selected products is unavailable. Refresh and try again.');
      const unitDefinition = UNIT_MAP.get(product.unit) || UNIT_MAP.get(DEFAULT_UNIT);
      if (!unitDefinition.fractional && !Number.isInteger(rawQuantity)) {
        throw new StoreError(`${product.name} is sold by the ${unitDefinition.label.toLowerCase()}. Enter a whole number.`);
      }
      const quantity = unitDefinition.fractional ? roundQuantity(rawQuantity) : rawQuantity;
      if (product.stock < quantity) throw new StoreError(`Not enough stock for ${product.name}. Available: ${product.stock} ${unitDefinition.shortLabel}.`);
      items.push({
        productId: product.id,
        productName: product.name,
        category: product.category,
        sku: product.sku,
        unit: product.unit,
        unitPrice: product.price,
        quantity,
        subtotal: Number((product.price * quantity).toFixed(2))
      });
    }

    const now = new Date().toISOString();
    const sale = {
      id: `KJ-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 5).toUpperCase()}`,
      createdAt: now,
      status: 'Completed',
      userId: user.id,
      itemCount: items.reduce((total, item) => total + item.quantity, 0),
      total: Number(items.reduce((total, item) => total + item.subtotal, 0).toFixed(2)),
      items
    };

    // Inventory deduction and sale creation are committed in one database write.
    for (const item of items) {
      const product = data.products.find((candidate) => candidate.id === item.productId);
      product.stock = roundQuantity(product.stock - item.quantity);
      product.updatedAt = now;
    }
    data.sales.unshift(sale);
    write(data);
    return clone(sale);
  }

  function legacyDashboard(period = 'daily') {
    const data = read();
    const activeProducts = data.products.filter((product) => !product.archived);
    const now = new Date();
    const graph = [];
    const startOfDay = (date) => {
      const result = new Date(date);
      result.setHours(0, 0, 0, 0);
      return result;
    };
    const startOfWeek = (date) => {
      const result = startOfDay(date);
      const day = result.getDay();
      result.setDate(result.getDate() - (day === 0 ? 6 : day - 1));
      return result;
    };
    let count;
    let unit;

    if (period === 'weekly') { count = 8; unit = 'week'; }
    else if (period === 'monthly') { count = 12; unit = 'month'; }
    else if (period === 'yearly') { count = 5; unit = 'year'; }
    else { count = 7; unit = 'day'; }

    const currentStart = unit === 'day' ? startOfDay(now) : unit === 'week' ? startOfWeek(now) : unit === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(now.getFullYear(), 0, 1);
    for (let index = count - 1; index >= 0; index -= 1) {
      const start = new Date(currentStart);
      if (unit === 'day') start.setDate(start.getDate() - index);
      if (unit === 'week') start.setDate(start.getDate() - (index * 7));
      if (unit === 'month') start.setMonth(start.getMonth() - index, 1);
      if (unit === 'year') start.setFullYear(start.getFullYear() - index, 0, 1);
      const end = new Date(start);
      if (unit === 'day') end.setDate(end.getDate() + 1);
      if (unit === 'week') end.setDate(end.getDate() + 7);
      if (unit === 'month') end.setMonth(end.getMonth() + 1);
      if (unit === 'year') end.setFullYear(end.getFullYear() + 1);
      const label = unit === 'day' ? start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : unit === 'week' ? `Week of ${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : unit === 'month' ? start.toLocaleDateString('en-US', { month: 'short' }) : String(start.getFullYear());
      const tooltip = unit === 'week' ? `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} – ${new Date(end.getTime() - 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : unit === 'day' ? start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : unit === 'month' ? start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : String(start.getFullYear());
      graph.push({ label, tooltip, start: start.getTime(), end: end.getTime(), total: 0 });
    }
    for (const sale of data.sales) {
      const time = new Date(sale.createdAt).getTime();
      const bucket = graph.find((entry) => time >= entry.start && time < entry.end);
      if (bucket) bucket.total += sale.total;
    }

    return {
      summary: {
        totalSales: Number(data.sales.reduce((total, sale) => total + sale.total, 0).toFixed(2)),
        transactionCount: data.sales.length,
        productsSold: data.sales.reduce((total, sale) => total + sale.itemCount, 0),
        currentStock: activeProducts.reduce((total, product) => total + product.stock, 0),
        lowStockCount: activeProducts.filter((product) => product.stock <= product.lowStockThreshold).length
      },
      graph: graph.map(({ label, tooltip, total }) => ({ label, tooltip, total: Number(total.toFixed(2)) }))
    };
  }

  function dashboard(rawFilter = 'this-week') {
    const data = read();
    const filter = typeof rawFilter === 'string' ? { type: rawFilter } : (rawFilter || {});
    const type = filter.type || 'this-week';
    const now = new Date();
    const startOfDay = (date) => { const result = new Date(date); result.setHours(0, 0, 0, 0); return result; };
    const addDays = (date, days) => { const result = new Date(date); result.setDate(result.getDate() + days); return result; };
    const startOfWeek = (date) => { const result = startOfDay(date); const day = result.getDay(); result.setDate(result.getDate() - (day === 0 ? 6 : day - 1)); return result; };
    const startOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1);
    const startOfYear = (date) => new Date(date.getFullYear(), 0, 1);
    const tomorrow = addDays(startOfDay(now), 1);
    if (type === 'custom' && (!filter.start || !filter.end)) {
      return {
        filter: { type, start: null, end: null, unit: 'day', userId: filter.userId || null },
        summary: { totalSales: 0, transactionCount: 0, productsSold: 0, averageSale: 0 },
        insights: { best: null, lowest: null },
        graph: []
      };
    }
    let start;
    let end = tomorrow;
    let unit = 'day';

    if (type === 'today') start = startOfDay(now);
    else if (type === 'yesterday') { start = addDays(startOfDay(now), -1); end = startOfDay(now); }
    else if (type === 'this-week') start = startOfWeek(now);
    else if (type === 'last-7-days' || type === 'daily') start = addDays(startOfDay(now), -6);
    else if (type === 'this-month') start = startOfMonth(now);
    else if (type === 'last-30-days') start = addDays(startOfDay(now), -29);
    else if (type === 'this-year') { start = startOfYear(now); unit = 'month'; }
    else if (type === 'weekly') { start = addDays(startOfWeek(now), -49); unit = 'week'; }
    else if (type === 'monthly') { start = new Date(now.getFullYear(), now.getMonth() - 11, 1); unit = 'month'; }
    else if (type === 'yearly') { start = new Date(now.getFullYear() - 4, 0, 1); unit = 'year'; }
    else if (type === 'custom') {
      if (!filter.start || !filter.end) throw new StoreError('Choose both a start date and an end date.');
      start = new Date(`${filter.start}T00:00:00`);
      end = new Date(`${filter.end}T00:00:00`);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) throw new StoreError('Choose a valid date range.');
      end = addDays(end, 1);
      const days = Math.ceil((end - start) / 86400000);
      unit = days > 730 ? 'year' : days > 90 ? 'month' : days > 31 ? 'week' : 'day';
    } else start = startOfWeek(now);

    const bucketStart = unit === 'day' ? startOfDay(start) : unit === 'week' ? startOfWeek(start) : unit === 'month' ? startOfMonth(start) : startOfYear(start);
    const graph = [];
    for (let bucketStartDate = new Date(bucketStart); bucketStartDate < end;) {
      const bucketEnd = new Date(bucketStartDate);
      if (unit === 'day') bucketEnd.setDate(bucketEnd.getDate() + 1);
      if (unit === 'week') bucketEnd.setDate(bucketEnd.getDate() + 7);
      if (unit === 'month') bucketEnd.setMonth(bucketEnd.getMonth() + 1);
      if (unit === 'year') bucketEnd.setFullYear(bucketEnd.getFullYear() + 1);
      const label = unit === 'day' ? bucketStartDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : unit === 'week' ? `Week of ${bucketStartDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : unit === 'month' ? bucketStartDate.toLocaleDateString('en-US', { month: 'short' }) : String(bucketStartDate.getFullYear());
      const tooltip = unit === 'week' ? `${bucketStartDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} to ${new Date(bucketEnd.getTime() - 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : unit === 'day' ? bucketStartDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : unit === 'month' ? bucketStartDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : String(bucketStartDate.getFullYear());
      graph.push({ label, tooltip, start: bucketStartDate.getTime(), end: bucketEnd.getTime(), total: 0, transactions: 0, itemsSold: 0 });
      bucketStartDate = bucketEnd;
    }

    const userId = filter.userId || null;
    const completedSales = collectSales(data, { start, end }).filter((sale) => sale.status === 'Completed' && (!userId || sale.userId === userId) && new Date(sale.createdAt).getTime() >= start.getTime() && new Date(sale.createdAt).getTime() < end.getTime());
    for (const sale of completedSales) {
      const time = new Date(sale.createdAt).getTime();
      const bucket = graph.find((entry) => time >= entry.start && time < entry.end);
      if (bucket) { bucket.total += sale.total; bucket.transactions += 1; bucket.itemsSold += sale.itemCount; }
    }
    const totalSales = Number(completedSales.reduce((total, sale) => total + sale.total, 0).toFixed(2));
    const transactionCount = completedSales.length;
    const productsSold = completedSales.reduce((total, sale) => total + sale.itemCount, 0);
    const periodsWithSales = graph.filter((period) => period.transactions > 0);
    const serializePeriod = (period) => period ? { label: period.tooltip, total: Number(period.total.toFixed(2)) } : null;

    return {
      filter: { type, start: start.toISOString(), end: end.toISOString(), unit, userId },
      summary: { totalSales, transactionCount, productsSold, averageSale: transactionCount ? Number((totalSales / transactionCount).toFixed(2)) : 0 },
      insights: { best: serializePeriod(periodsWithSales.reduce((best, period) => !best || period.total > best.total ? period : best, null)), lowest: serializePeriod(periodsWithSales.reduce((lowest, period) => !lowest || period.total < lowest.total ? period : lowest, null)) },
      graph: graph.map(({ label, tooltip, total, transactions, itemsSold }) => ({ label, tooltip, total: Number(total.toFixed(2)), transactions, itemsSold }))
    };
  }

  // Same date-window semantics as dashboard(), factored out so salesReport can
  // share it without touching the already-working dashboard() implementation.
  function resolveDateRange(filter) {
    const type = filter.type || 'this-month';
    const now = new Date();
    const startOfDay = (date) => { const result = new Date(date); result.setHours(0, 0, 0, 0); return result; };
    const addDays = (date, days) => { const result = new Date(date); result.setDate(result.getDate() + days); return result; };
    const startOfWeek = (date) => { const result = startOfDay(date); const day = result.getDay(); result.setDate(result.getDate() - (day === 0 ? 6 : day - 1)); return result; };
    const startOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1);
    const startOfYear = (date) => new Date(date.getFullYear(), 0, 1);
    const tomorrow = addDays(startOfDay(now), 1);
    if (type === 'custom' && (!filter.start || !filter.end)) return null;
    let start;
    let end = tomorrow;
    if (type === 'today') start = startOfDay(now);
    else if (type === 'yesterday') { start = addDays(startOfDay(now), -1); end = startOfDay(now); }
    else if (type === 'this-week') start = startOfWeek(now);
    else if (type === 'last-7-days') start = addDays(startOfDay(now), -6);
    else if (type === 'this-month') start = startOfMonth(now);
    else if (type === 'last-30-days') start = addDays(startOfDay(now), -29);
    else if (type === 'this-year') start = startOfYear(now);
    else if (type === 'custom') {
      start = new Date(`${filter.start}T00:00:00`);
      end = new Date(`${filter.end}T00:00:00`);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) throw new StoreError('Choose a valid date range.');
      end = addDays(end, 1);
    } else start = startOfMonth(now);
    return { type, start, end };
  }

  function salesReport(rawFilter = 'this-month') {
    const data = read();
    const filter = typeof rawFilter === 'string' ? { type: rawFilter } : (rawFilter || {});
    const range = resolveDateRange(filter);
    const userId = filter.userId || null;
    const emptyResult = () => ({
      filter: { type: filter.type || 'this-month', start: range ? range.start.toISOString() : null, end: range ? range.end.toISOString() : null, userId },
      summary: { totalSales: 0, transactionCount: 0, itemsSold: 0, averageTransactionValue: 0 },
      byDate: [], byProduct: [], byCategory: [], byUser: []
    });
    if (!range) return emptyResult();
    const { start, end } = range;
    const sales = collectSales(data, { start, end }).filter((sale) => sale.status === 'Completed' && (!userId || sale.userId === userId) && new Date(sale.createdAt).getTime() >= start.getTime() && new Date(sale.createdAt).getTime() < end.getTime());
    if (!sales.length) return emptyResult();

    const round2 = (value) => Number(value.toFixed(2));
    const totalSales = round2(sales.reduce((total, sale) => total + sale.total, 0));
    const transactionCount = sales.length;
    const itemsSold = roundQuantity(sales.reduce((total, sale) => total + sale.itemCount, 0));
    const userNameById = new Map(data.users.map((user) => [user.id, user.name]));

    const byDateMap = new Map();
    const byProductMap = new Map();
    const byCategoryMap = new Map();
    const byUserMap = new Map();
    for (const sale of sales) {
      const dateKey = new Date(sale.createdAt).toISOString().slice(0, 10);
      const dateEntry = byDateMap.get(dateKey) || { date: dateKey, totalSales: 0, transactionCount: 0, itemsSold: 0 };
      dateEntry.totalSales += sale.total; dateEntry.transactionCount += 1; dateEntry.itemsSold += sale.itemCount;
      byDateMap.set(dateKey, dateEntry);

      const userKey = sale.userId || 'unknown';
      const userEntry = byUserMap.get(userKey) || { userId: sale.userId || null, userName: sale.userId ? (userNameById.get(sale.userId) || 'Deactivated user') : 'Unknown user', totalSales: 0, transactionCount: 0, itemsSold: 0 };
      userEntry.totalSales += sale.total; userEntry.transactionCount += 1; userEntry.itemsSold += sale.itemCount;
      byUserMap.set(userKey, userEntry);

      for (const item of sale.items) {
        const productEntry = byProductMap.get(item.productId) || { productId: item.productId, productName: item.productName, sku: item.sku, quantitySold: 0, totalSales: 0 };
        productEntry.quantitySold = roundQuantity(productEntry.quantitySold + item.quantity);
        productEntry.totalSales += item.subtotal;
        byProductMap.set(item.productId, productEntry);

        const categoryEntry = byCategoryMap.get(item.category) || { category: item.category, quantitySold: 0, totalSales: 0 };
        categoryEntry.quantitySold = roundQuantity(categoryEntry.quantitySold + item.quantity);
        categoryEntry.totalSales += item.subtotal;
        byCategoryMap.set(item.category, categoryEntry);
      }
    }
    return {
      filter: { type: filter.type || 'this-month', start: start.toISOString(), end: end.toISOString(), userId },
      summary: { totalSales, transactionCount, itemsSold, averageTransactionValue: transactionCount ? round2(totalSales / transactionCount) : 0 },
      byDate: [...byDateMap.values()].map((entry) => ({ ...entry, totalSales: round2(entry.totalSales) })).sort((a, b) => a.date.localeCompare(b.date)),
      byProduct: [...byProductMap.values()].map((entry) => ({ ...entry, totalSales: round2(entry.totalSales) })).sort((a, b) => b.totalSales - a.totalSales),
      byCategory: [...byCategoryMap.values()].map((entry) => ({ ...entry, totalSales: round2(entry.totalSales) })).sort((a, b) => b.totalSales - a.totalSales),
      byUser: [...byUserMap.values()].map((entry) => ({ ...entry, totalSales: round2(entry.totalSales) })).sort((a, b) => b.totalSales - a.totalSales)
    };
  }

  function inventoryReport() {
    const data = read();
    const round2 = (value) => Number(value.toFixed(2));
    const products = data.products.filter((product) => !product.archived);
    const lowStock = products.filter((product) => product.stock > 0 && product.stock <= product.lowStockThreshold);
    const outOfStock = products.filter((product) => !product.stock);
    const byCategoryMap = new Map();
    for (const product of products) {
      const entry = byCategoryMap.get(product.category) || { category: product.category, productCount: 0, valueAtCost: 0, valueAtRetail: 0 };
      entry.productCount += 1;
      entry.valueAtCost += product.stock * product.costPrice;
      entry.valueAtRetail += product.stock * product.price;
      byCategoryMap.set(product.category, entry);
    }
    return {
      summary: {
        totalProducts: products.length,
        lowStockCount: lowStock.length,
        outOfStockCount: outOfStock.length,
        inventoryValueAtCost: round2(products.reduce((total, product) => total + (product.stock * product.costPrice), 0)),
        inventoryValueAtRetail: round2(products.reduce((total, product) => total + (product.stock * product.price), 0))
      },
      byCategory: [...byCategoryMap.values()].map((entry) => ({ ...entry, valueAtCost: round2(entry.valueAtCost), valueAtRetail: round2(entry.valueAtRetail) })).sort((a, b) => b.valueAtRetail - a.valueAtRetail),
      lowStock: clone(lowStock),
      outOfStock: clone(outOfStock)
    };
  }

  // ---- Product import (CSV) ----

  const IMPORT_FIELD_ALIASES = {
    name: ['name', 'product name', 'product'],
    sku: ['sku', 'sku / barcode', 'sku/barcode', 'barcode'],
    category: ['category'],
    price: ['price', 'selling price', 'price (php)', 'selling price (php)'],
    costPrice: ['cost price', 'cost', 'costprice', 'cost price (php)'],
    stock: ['stock', 'stock quantity', 'quantity', 'qty'],
    unit: ['unit', 'unit of measurement', 'uom']
  };
  function mapImportRecord(record) {
    const mapped = {};
    for (const [field, aliases] of Object.entries(IMPORT_FIELD_ALIASES)) {
      const key = aliases.find((alias) => record[alias] !== undefined && record[alias] !== '');
      mapped[field] = key ? record[key] : '';
    }
    return mapped;
  }
  function validateImportRow(mapped, data) {
    const errors = [];
    const name = String(mapped.name || '').trim();
    const sku = String(mapped.sku || '').trim();
    const category = String(mapped.category || '').trim();
    const unit = String(mapped.unit || DEFAULT_UNIT).trim().toLowerCase() || DEFAULT_UNIT;
    const price = mapped.price === '' ? NaN : Number(mapped.price);
    const costPrice = mapped.costPrice === '' ? 0 : Number(mapped.costPrice);
    const stock = mapped.stock === '' ? NaN : Number(mapped.stock);

    if (!name) errors.push('Missing product name.');
    else if (name.length > 100) errors.push('Product name is too long (max 100 characters).');
    if (!CATEGORIES.includes(category)) errors.push(`Category must be one of: ${CATEGORIES.join(', ')}.`);
    const unitDefinition = UNIT_MAP.get(unit);
    if (!unitDefinition) errors.push(`Unit must be one of: ${UNITS.map((entry) => entry.value).join(', ')}.`);
    if (!Number.isFinite(price) || price < 0) errors.push('Selling price must be a number, zero or greater.');
    if (!Number.isFinite(costPrice) || costPrice < 0) errors.push('Cost price must be a number, zero or greater.');
    if (!Number.isFinite(stock) || stock < 0) errors.push('Stock quantity must be a number, zero or greater.');
    else if (unitDefinition && !unitDefinition.fractional && !Number.isInteger(stock)) errors.push(`Stock must be a whole number for unit "${unit}".`);

    const existing = sku ? data.products.find((product) => product.sku && product.sku.toLowerCase() === sku.toLowerCase()) : null;
    return {
      input: {
        name, sku, category, unit,
        price: Number.isFinite(price) ? Number(price.toFixed(2)) : price,
        costPrice: Number.isFinite(costPrice) ? Number(costPrice.toFixed(2)) : costPrice,
        stock: Number.isFinite(stock) && unitDefinition?.fractional ? roundQuantity(stock) : stock,
        lowStockThreshold: existing ? existing.lowStockThreshold : 5
      },
      errors,
      duplicateOf: existing ? existing.id : null
    };
  }
  // Shared by preview and commit so the two can never disagree about which
  // rows are new/duplicate/invalid.
  function evaluateImportRows(records, data) {
    const claimedSkus = new Map();
    return records.map((record, index) => {
      const rowNumber = index + 2; // header is row 1
      const mapped = mapImportRecord(record);
      const { input, errors, duplicateOf } = validateImportRow(mapped, data);
      if (errors.length) return { rowNumber, input, errors, status: 'error', duplicateOf: null };
      if (input.sku) {
        const key = input.sku.toLowerCase();
        if (claimedSkus.has(key)) return { rowNumber, input, errors: [`Duplicate SKU within this file (already used by row ${claimedSkus.get(key)}).`], status: 'error', duplicateOf: null };
        claimedSkus.set(key, rowNumber);
      }
      return { rowNumber, input, errors: [], status: duplicateOf ? 'duplicate' : 'new', duplicateOf };
    });
  }
  function previewImport(csvText) {
    const data = read();
    const records = parseCsvRecords(csvText);
    if (!records.length) throw new StoreError('The file has no data rows to import.');
    const rows = evaluateImportRows(records, data);
    return {
      totalRows: rows.length,
      newCount: rows.filter((row) => row.status === 'new').length,
      duplicateCount: rows.filter((row) => row.status === 'duplicate').length,
      errorCount: rows.filter((row) => row.status === 'error').length,
      rows: rows.map((row) => ({ rowNumber: row.rowNumber, status: row.status, errors: row.errors, ...row.input }))
    };
  }
  function commitImport(csvText, duplicateStrategy = 'skip') {
    if (!['skip', 'update'].includes(duplicateStrategy)) throw new StoreError('Choose a valid duplicate-handling option.');
    const data = read();
    const records = parseCsvRecords(csvText);
    if (!records.length) throw new StoreError('The file has no data rows to import.');
    const rows = evaluateImportRows(records, data);
    const now = new Date().toISOString();
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    // Every row is evaluated against the same in-memory `data` first, and the
    // database file is only written once at the end, so a mid-import crash
    // (or an invalid duplicateStrategy caught above) never leaves a partially
    // written file on disk.
    for (const row of rows) {
      if (row.status === 'error') continue;
      if (row.status === 'duplicate') {
        if (duplicateStrategy === 'skip') { skipped += 1; continue; }
        const existing = data.products.find((product) => product.id === row.duplicateOf);
        Object.assign(existing, { name: row.input.name, category: row.input.category, unit: row.input.unit, price: row.input.price, costPrice: row.input.costPrice, stock: row.input.stock, updatedAt: now });
        updated += 1;
      } else {
        data.products.push({ id: randomUUID(), name: row.input.name, sku: row.input.sku, category: row.input.category, unit: row.input.unit, price: row.input.price, costPrice: row.input.costPrice, stock: row.input.stock, lowStockThreshold: row.input.lowStockThreshold, archived: false, createdAt: now, updatedAt: now });
        imported += 1;
      }
    }
    write(data);
    const errorRows = rows.filter((row) => row.status === 'error').map((row) => ({ rowNumber: row.rowNumber, errors: row.errors }));
    return { imported, updated, skipped, errorCount: errorRows.length, errors: errorRows };
  }

  function listSales(filters = {}) {
    const data = read();
    const search = String(filters.search || '').trim().toLowerCase();
    const start = filters.start ? new Date(`${filters.start}T00:00:00`) : null;
    const end = filters.end ? new Date(`${filters.end}T23:59:59.999`) : null;
    const userId = filters.userId || null;
    const pool = collectSales(data, { start, end, includeArchived: filters.includeArchived === true });
    return clone(pool.filter((sale) => {
      const time = new Date(sale.createdAt).getTime();
      return (!search || sale.id.toLowerCase().includes(search)) && (!start || time >= start.getTime()) && (!end || time <= end.getTime()) && (!userId || sale.userId === userId);
    }));
  }

  // Mirrors the Inventory page's own search/category filtering, server-side,
  // so an export can be told "export exactly what's currently on screen".
  function listProducts(filters = {}) {
    const search = String(filters.search || '').trim().toLowerCase();
    const category = String(filters.category || '').trim();
    return clone(read().products.filter((product) => !product.archived
      && (!category || product.category === category)
      && (!search || product.name.toLowerCase().includes(search) || (product.sku && product.sku.toLowerCase().includes(search)))));
  }

  function getSale(id) {
    const data = read();
    let sale = data.sales.find((item) => item.id === id);
    if (!sale) {
      for (const year of listArchiveYears()) {
        sale = readArchiveYear(year).find((item) => item.id === id);
        if (sale) break;
      }
    }
    if (!sale) throw new StoreError('Sale not found.');
    return clone(sale);
  }

  // Completed sales are never edited or deleted -- that would silently corrupt
  // stock levels and past reports, and erase the audit trail of what actually
  // happened. Instead, voiding restores the deducted stock and marks the sale
  // "Voided" in place, keeping the original record (and who/why/when it was
  // reversed) fully visible in History.
  function voidSale(saleId, userId, reason) {
    const data = read();
    let sale = data.sales.find((item) => item.id === saleId);
    let archiveYear = null;
    if (!sale) {
      for (const year of listArchiveYears()) {
        const found = readArchiveYear(year).find((item) => item.id === saleId);
        if (found) { sale = found; archiveYear = year; break; }
      }
    }
    if (!sale) throw new StoreError('Sale not found.');
    if (sale.status === 'Voided') throw new StoreError('This sale has already been voided.');
    const cleanReason = String(reason || '').trim();
    if (!cleanReason) throw new StoreError('Enter a reason for voiding this sale.');
    if (cleanReason.length > 200) throw new StoreError('Reason must be 200 characters or fewer.');

    const now = new Date().toISOString();
    for (const item of sale.items) {
      const product = data.products.find((candidate) => candidate.id === item.productId);
      if (!product) continue; // defensive: products are only archived, never deleted, so this shouldn't happen
      const unitDefinition = UNIT_MAP.get(product.unit) || UNIT_MAP.get(DEFAULT_UNIT);
      product.stock = unitDefinition.fractional ? roundQuantity(product.stock + item.quantity) : product.stock + item.quantity;
      product.updatedAt = now;
    }
    sale.status = 'Voided';
    sale.voidedAt = now;
    sale.voidedBy = userId;
    sale.voidReason = cleanReason;

    if (archiveYear !== null) {
      // The stock restoration above still needs to land in the hot file
      // (products always live there); the sale itself gets rewritten back
      // into its own archive-year file.
      const updatedYearSales = readArchiveYear(archiveYear).map((item) => (item.id === saleId ? sale : item));
      writeArchiveYear(archiveYear, updatedYearSales);
    }
    write(data);
    return clone(sale);
  }

  return {
    CATEGORIES,
    UNITS,
    initialize,
    getData,
    seedDemoData,
    createProduct,
    updateProduct,
    archiveProduct,
    completeSale,
    dashboard,
    listSales,
    listProducts,
    getSale,
    voidSale,
    salesReport,
    inventoryReport,
    previewImport,
    commitImport,
    archiveSalesBefore,
    archiveSummary,
    authenticate,
    getSession,
    clearSession,
    listUsers,
    getUser,
    createUser,
    updateUser
  };
}

module.exports = { createStore, StoreError, CATEGORIES };
