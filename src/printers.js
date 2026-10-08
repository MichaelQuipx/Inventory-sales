// Picks which installed Windows printer to use for receipts. Kept free of
// Electron so it can be unit-tested.
const THERMAL_PRINTER_PATTERN = /thermal|receipt|\bpos[-\s_]?\d|\bxp[-\s_]?\d|58|rongta|bixolon|star\s?tsp|tm-[tu]\d|gprinter|zjiang|hprt|munbyn|epson tm/i;

function looksLikeThermalPrinter(printer) {
  return THERMAL_PRINTER_PATTERN.test(`${printer.name} ${printer.displayName || ''} ${printer.description || ''}`);
}

// Preference: the printer saved last time -> a thermal-looking printer
// (58mm models first) -> the Windows default -> the first one installed.
// `printers` entries need { name, isDefault, looksThermal }.
function pickPrinter(printers, savedName) {
  if (!printers.length) return null;
  return printers.find((printer) => printer.name === savedName)
    || printers.find((printer) => printer.looksThermal && /58/.test(printer.name))
    || printers.find((printer) => printer.looksThermal)
    || printers.find((printer) => printer.isDefault)
    || printers[0];
}

module.exports = { looksLikeThermalPrinter, pickPrinter };
