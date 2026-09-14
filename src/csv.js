// Minimal, dependency-free CSV reader/writer. Handles quoted fields, commas
// and newlines inside quotes, escaped quotes (""), and both \n and \r\n line
// endings, which covers what Excel/Google Sheets/LibreOffice actually produce.

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

// columns: [{ label, value(row) }]
function toCsv(columns, rows) {
  const header = columns.map((column) => csvEscape(column.label)).join(',');
  const body = rows.map((row) => columns.map((column) => csvEscape(column.value(row))).join(',')).join('\r\n');
  return rows.length ? `${header}\r\n${body}\r\n` : `${header}\r\n`;
}

// Builds a CSV with multiple titled sections separated by a blank line, used
// for report exports (totals + several breakdown tables in one file).
function toSectionedCsv(sections) {
  return sections.map(({ title, columns, rows }) => {
    const heading = title ? `${csvEscape(title)}\r\n` : '';
    return heading + toCsv(columns, rows);
  }).join('\r\n');
}

// Returns an array of string arrays (one per row, header included).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const source = String(text ?? '').replace(/^\uFEFF/, ''); // strip BOM if present
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char === '\r') {
      // swallow; the following \n (if any) ends the row
    } else {
      field += char;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((cells) => !(cells.length === 1 && cells[0] === ''));
}

// Parses a CSV with a header row into an array of plain objects keyed by a
// normalized (lowercased, trimmed) version of each header, so callers can
// tolerate header variations like "Selling Price" vs "Price".
function parseCsvRecords(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headers = rows[0].map((header) => String(header || '').trim().toLowerCase());
  return rows.slice(1).map((cells) => {
    const record = {};
    headers.forEach((header, index) => { record[header] = cells[index] !== undefined ? String(cells[index]).trim() : ''; });
    return record;
  });
}

module.exports = { toCsv, toSectionedCsv, parseCsv, parseCsvRecords, csvEscape };
