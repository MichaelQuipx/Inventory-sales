// Builds the printable thermal receipt for a completed sale.
//
// The receipt is a fixed-width TEXT layout (32 columns on 58mm paper, 48 on
// 80mm), padded with real spaces and limited to plain ASCII. That is
// deliberate: many thermal printers/drivers (e.g. "Generic / Text Only") flatten
// a page to text, which drops CSS layout (columns, dashed rules, right-aligned
// amounts) and can't print characters like the peso sign or "x" symbol -- they
// came out as "?" and "#". A pre-padded ASCII line prints identically on any
// driver, and the on-screen preview shows exactly the same lines.

const PAPER_WIDTHS = { '58mm': 58, '80mm': 80 };
const COLUMNS = { 58: 32, 80: 48 };
// Thermal heads print ~48mm of a 58mm roll and ~72mm of an 80mm roll.
const PRINTABLE_MM = { 58: 48, 80: 72 };

const DEFAULT_LAYOUT = { topMarginLines: 1, bottomMarginLines: 5, leftMarginChars: 0, minLines: 20 };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
// Strips accents and replaces anything outside printable ASCII, since thermal
// printer code pages can't draw it.
function asciiSafe(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '?');
}
function money(value) {
  return `P${Number(value ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function formatQuantity(value) {
  const number = Number(value ?? 0);
  return Number.isInteger(number) ? String(number) : String(Math.round(number * 1000) / 1000);
}
function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function clampInt(value, min, max, fallback) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function wrapText(text, width) {
  const lines = [];
  let line = '';
  for (const word of asciiSafe(text).split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (rest.length > width) {
      if (line) { lines.push(line); line = ''; }
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (!line) line = rest;
    else if (line.length + 1 + rest.length <= width) line += ` ${rest}`;
    else { lines.push(line); line = rest; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}
function center(text, width) {
  const t = asciiSafe(text).slice(0, width);
  return ' '.repeat(Math.floor((width - t.length) / 2)) + t;
}
// "left ........ right" on one line; if it doesn't fit, left wraps onto its
// own line(s) and the amount goes right-aligned on the next line.
function twoColumn(left, right, width) {
  const l = asciiSafe(left);
  const r = asciiSafe(right);
  if (l.length + 1 + r.length <= width) return [l + ' '.repeat(width - l.length - r.length) + r];
  return [...wrapText(l, width), ' '.repeat(Math.max(0, width - r.length)) + r];
}

// Returns [{ text, bold }] -- exactly what gets printed and previewed.
function buildReceiptLines(sale, { paperWidth = '80mm', processedByName = null, layout = {} } = {}) {
  const widthMm = PAPER_WIDTHS[paperWidth] || PAPER_WIDTHS['80mm'];
  const cols = COLUMNS[widthMm];
  const rule = '-'.repeat(cols);
  const opts = {
    topMarginLines: clampInt(layout.topMarginLines, 0, 10, DEFAULT_LAYOUT.topMarginLines),
    bottomMarginLines: clampInt(layout.bottomMarginLines, 0, 20, DEFAULT_LAYOUT.bottomMarginLines),
    leftMarginChars: clampInt(layout.leftMarginChars, 0, 6, DEFAULT_LAYOUT.leftMarginChars),
    minLines: clampInt(layout.minLines, 0, 80, DEFAULT_LAYOUT.minLines)
  };
  const lines = [];
  const add = (text, bold = false) => lines.push({ text, bold });

  add(center('KJ STORE', cols), true);
  add(center('Inventory & Sales', cols));
  add(rule);
  for (const text of wrapText(`Receipt #: ${sale.id}`, cols)) add(text);
  const date = formatDateTime(sale.createdAt);
  if (date) for (const text of wrapText(`Date: ${date}`, cols)) add(text);
  if (processedByName) for (const text of wrapText(`Cashier: ${processedByName}`, cols)) add(text);
  add(rule);

  for (const item of sale.items || []) {
    for (const text of wrapText(item.productName, cols)) add(text, true);
    const unit = item.unit ? ` ${item.unit}` : '';
    for (const text of twoColumn(`${formatQuantity(item.quantity)}${unit} x ${money(item.unitPrice)}`, money(item.subtotal), cols)) add(text);
  }
  add(rule);

  const itemCount = typeof sale.itemCount === 'number' ? sale.itemCount : (sale.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  for (const text of twoColumn('Items', formatQuantity(itemCount), cols)) add(text);
  if (sale.discount) {
    for (const text of twoColumn('Subtotal', money(sale.subtotal ?? sale.total), cols)) add(text);
    for (const text of twoColumn('Discount', `-${money(sale.discount)}`, cols)) add(text);
  }
  add(rule);
  for (const text of twoColumn('TOTAL', money(sale.total), cols)) add(text, true);
  add(rule);
  add(center('Thank you for shopping!', cols));

  // Margins and minimum length are blank lines, because a text-only driver
  // ignores CSS padding/page height but always honours line feeds.
  const pad = ' '.repeat(opts.leftMarginChars);
  const body = lines.map((line) => ({ ...line, text: pad + line.text }));
  const blank = { text: '', bold: false };
  const result = [...Array(opts.topMarginLines).fill(blank), ...body];
  while (result.length + opts.bottomMarginLines < opts.minLines) result.push(blank);
  result.push(...Array(opts.bottomMarginLines).fill(blank));
  return result;
}

function buildReceiptHtml(sale, { paperWidth = '80mm', processedByName = null, layout = {} } = {}) {
  const widthMm = PAPER_WIDTHS[paperWidth] || PAPER_WIDTHS['80mm'];
  const sidePaddingMm = (widthMm - PRINTABLE_MM[widthMm]) / 2;
  const rows = buildReceiptLines(sale, { paperWidth, processedByName, layout })
    .map((line) => `<div class="ln${line.bold ? ' b' : ''}">${line.text ? escapeHtml(line.text) : '&nbsp;'}</div>`).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Receipt ${escapeHtml(sale.id)}</title>
<style>
  @page { size: ${widthMm}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { width: ${widthMm}mm; padding: 0 ${sidePaddingMm}mm; color: #000; }
  .ln { font-family: "Consolas", "Lucida Console", "Courier New", monospace; font-size: 10px; line-height: 14px; white-space: pre; }
  .b { font-weight: 700; }
</style>
</head>
<body>${rows}</body>
</html>`;
}

module.exports = { buildReceiptHtml, buildReceiptLines, DEFAULT_LAYOUT };
