// Renders a printable thermal-receipt HTML document for a completed sale.
// Supports 58mm and 80mm paper widths. Built from scratch: this codebase had
// no prior receipt/print implementation of any kind.

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function money(value) {
  return `\u20B1${Number(value ?? 0).toFixed(2)}`;
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

const PAPER_WIDTHS = { '58mm': 58, '80mm': 80 };

// sale: the existing sale record shape (id, createdAt, items[], total, userId, ...).
// processedByName: resolved separately by the caller (main.js already has a
// userDisplayName helper); passed in rather than re-derived here so this
// module has no dependency on the store.
function buildReceiptHtml(sale, { paperWidth = '80mm', processedByName = null } = {}) {
  const widthMm = PAPER_WIDTHS[paperWidth] || PAPER_WIDTHS['80mm'];
  const isNarrow = widthMm <= 58;
  const fontSize = isNarrow ? 11 : 12;

  const itemRows = (sale.items || []).map((item) => {
    const unit = item.unit ? escapeHtml(item.unit) : '';
    const lineDetail = `${formatQuantity(item.quantity)}${unit ? ` ${unit}` : ''} &times; ${money(item.unitPrice)}`;
    return `
      <tr><td colspan="2" class="item-name">${escapeHtml(item.productName)}</td></tr>
      <tr><td class="item-detail">${lineDetail}</td><td class="amount">${money(item.subtotal)}</td></tr>`;
  }).join('');

  const metaRows = [
    ['Receipt #', sale.id],
    ['Date', formatDateTime(sale.createdAt)],
    processedByName ? ['Processed By', processedByName] : null
  ].filter(Boolean).map(([label, value]) => `<div class="meta-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Receipt ${escapeHtml(sale.id)}</title>
<style>
  @page { size: ${widthMm}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: ${widthMm}mm;
    padding: 3mm 3mm 6mm;
    font-family: "Consolas", "Courier New", monospace;
    font-size: ${fontSize}px;
    line-height: 1.4;
    color: #000;
  }
  .center { text-align: center; }
  .store-name { font-size: ${fontSize + 4}px; font-weight: 700; }
  .tagline { font-size: ${fontSize - 1}px; }
  hr { border: none; border-top: 1px dashed #000; margin: 5px 0; }
  .meta-row { display: flex; justify-content: space-between; gap: 6px; }
  .meta-row span:last-child { text-align: right; word-break: break-word; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  .item-name { font-weight: 600; word-break: break-word; white-space: normal; padding-top: 4px; }
  .item-detail { color: #222; white-space: normal; word-break: break-word; }
  .amount { text-align: right; white-space: nowrap; }
  .totals-table td { padding-top: 3px; }
  .grand-total td { font-weight: 700; font-size: ${fontSize + 2}px; border-top: 1px dashed #000; padding-top: 5px; }
  .footer { margin-top: 8px; font-size: ${fontSize - 1}px; }
</style>
</head>
<body>
  <div class="center store-name">KJ STORE</div>
  <div class="center tagline">Inventory &amp; Sales</div>
  <hr>
  ${metaRows}
  <hr>
  <table>${itemRows}</table>
  <hr>
  <table class="totals-table">
    <tr class="grand-total"><td>TOTAL</td><td class="amount">${money(sale.total)}</td></tr>
  </table>
  <hr>
  <div class="center footer">Thank you for shopping with us!</div>
</body>
</html>`;
}

module.exports = { buildReceiptHtml };
