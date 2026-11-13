/** CSV helpers shared by the status report and the admin exports. */

/** Quote a cell and neutralise spreadsheet formula injection (OWASP CSV injection). */
export function csvCell(value) {
  let s = value instanceof Date ? value.toISOString() : String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV document (UTF-8 BOM so Excel detects the encoding, CRLF line ends). */
export function toCsv(header, rows) {
  return '\uFEFF' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
