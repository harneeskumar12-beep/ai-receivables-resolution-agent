/**
 * Minimal CSV parser for invoice import. No dependency - hand-rolled,
 * RFC4180-style: double-quoted fields, "" as an escaped quote inside a
 * quoted field, and commas/newlines allowed inside quotes.
 *
 * Fails closed: if any row is malformed, or a required column is missing,
 * the whole import is rejected with every problem found - nothing is
 * partially imported and nothing is guessed at.
 */

export interface ParsedInvoiceRow {
  invoice_id: string;
  customer: string;
  customer_email: string;
  amount: number;
  due_date: string;
  status: string;
}

export type CsvParseResult =
  | { ok: true; rows: ParsedInvoiceRow[] }
  | { ok: false; errors: string[] };

const REQUIRED_COLUMNS = ["invoice_id", "customer", "customer_email", "amount", "due_date", "status"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Tokenize CSV text into rows of raw string cells, honoring quoted fields. */
function tokenizeCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop lines that are entirely blank (a single empty cell) - whitespace,
  // not data, and not worth rejecting the import over.
  return rows.filter((r) => !(r.length === 1 && (r[0] ?? "").trim() === ""));
}

function toFiniteNonNegative(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null; // Number("") is 0, not "missing" - must not be accepted as a real amount.
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parse CSV text with a header row into invoice rows. Required columns may
 * appear in any order; other columns present are ignored. Fails closed:
 * missing required columns, or any row with an invalid/missing value or the
 * wrong number of cells, rejects the entire import with a precise per-row
 * error - never a partial import, never a guessed value.
 */
export function parseInvoiceCsv(text: string): CsvParseResult {
  const rows = tokenizeCsv(text);
  if (rows.length === 0) {
    return { ok: false, errors: ["CSV is empty."] };
  }

  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return { ok: false, errors: [`Missing required column(s): ${missing.join(", ")}.`] };
  }

  const colIndex = new Map<string, number>();
  header.forEach((h, i) => {
    if (!colIndex.has(h)) colIndex.set(h, i);
  });

  const dataRows = rows.slice(1);
  const errors: string[] = [];
  const parsedRows: ParsedInvoiceRow[] = [];
  const seenIds = new Set<string>();

  dataRows.forEach((cells, idx) => {
    const rowNum = idx + 2; // 1-indexed data row, plus the header row
    const get = (col: string): string => (cells[colIndex.get(col) ?? -1] ?? "").trim();

    if (cells.length < header.length) {
      errors.push(`Row ${rowNum}: expected ${header.length} column(s), found ${cells.length}.`);
      return;
    }

    const invoice_id = get("invoice_id");
    const customer = get("customer");
    const customer_email = get("customer_email");
    const amountRaw = get("amount");
    const due_date = get("due_date");
    const status = get("status");

    const rowErrors: string[] = [];
    if (invoice_id.length === 0) rowErrors.push("invoice_id is required");
    if (invoice_id.length > 0 && seenIds.has(invoice_id)) rowErrors.push(`duplicate invoice_id "${invoice_id}"`);
    if (customer.length === 0) rowErrors.push("customer is required");
    if (customer_email.length === 0) rowErrors.push("customer_email is required");
    const amount = toFiniteNonNegative(amountRaw);
    if (amount === null) rowErrors.push(`amount "${amountRaw}" is not a valid non-negative number`);
    if (!DATE_RE.test(due_date)) rowErrors.push(`due_date "${due_date}" is not in YYYY-MM-DD format`);
    if (status.length === 0) rowErrors.push("status is required");

    if (rowErrors.length > 0) {
      errors.push(`Row ${rowNum}: ${rowErrors.join("; ")}.`);
      return;
    }

    seenIds.add(invoice_id);
    parsedRows.push({ invoice_id, customer, customer_email, amount: amount as number, due_date, status });
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, rows: parsedRows };
}
