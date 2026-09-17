import test from "node:test";
import assert from "node:assert/strict";

import { parseInvoiceCsv } from "../src/csv-parser.ts";

test("parses a valid CSV with the required columns", () => {
  const csv = "invoice_id,customer,customer_email,amount,due_date,status\nINV-1,Acme Co,ap@acme.com,4200,2026-08-29,unpaid\n";
  const r = parseInvoiceCsv(csv);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.rows.length === 1);
  assert.ok(r.ok && r.rows[0]?.invoice_id === "INV-1");
  assert.ok(r.ok && r.rows[0]?.amount === 4200);
  assert.ok(r.ok && r.rows[0]?.due_date === "2026-08-29");
});

test("supports quoted values with embedded commas, and escaped quotes", () => {
  const csv =
    'invoice_id,customer,customer_email,amount,due_date,status\n' +
    '"INV-2","Smith, Jones & Co","ap@sj.com",2500.5,2026-07-15,"past due, ""urgent"""\n';
  const r = parseInvoiceCsv(csv);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.rows[0]?.customer === "Smith, Jones & Co");
  assert.ok(r.ok && r.rows[0]?.status === 'past due, "urgent"');
  assert.ok(r.ok && r.rows[0]?.amount === 2500.5);
});

test("required columns may appear in any order", () => {
  const csv = "status,due_date,amount,customer_email,customer,invoice_id\nunpaid,2026-08-29,100,a@b.com,Acme,INV-9\n";
  const r = parseInvoiceCsv(csv);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.rows[0]?.invoice_id === "INV-9");
});

test("rejects a malformed row (missing amount) cleanly, without partially importing", () => {
  const csv =
    "invoice_id,customer,customer_email,amount,due_date,status\n" +
    "INV-1,Acme,a@b.com,,2026-08-29,unpaid\n" +
    "INV-2,Beta,b@c.com,500,2026-08-01,unpaid\n";
  const r = parseInvoiceCsv(csv);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.some((e) => e.includes("Row 2") && e.includes("amount")));
});

test("rejects CSV missing a required column", () => {
  const csv = "invoice_id,customer,amount,due_date,status\nINV-1,Acme,100,2026-08-29,unpaid\n";
  const r = parseInvoiceCsv(csv);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.some((e) => e.includes("customer_email")));
});

test("rejects a row with an invalid due_date format", () => {
  const csv = "invoice_id,customer,customer_email,amount,due_date,status\nINV-1,Acme,a@b.com,100,08/29/2026,unpaid\n";
  const r = parseInvoiceCsv(csv);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.some((e) => e.includes("due_date")));
});

test("rejects duplicate invoice_id values", () => {
  const csv =
    "invoice_id,customer,customer_email,amount,due_date,status\n" +
    "INV-1,Acme,a@b.com,100,2026-08-29,unpaid\n" +
    "INV-1,Beta,b@c.com,200,2026-08-01,unpaid\n";
  const r = parseInvoiceCsv(csv);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.some((e) => e.includes("duplicate")));
});

test("empty CSV is rejected", () => {
  const r = parseInvoiceCsv("");
  assert.equal(r.ok, false);
});

test("a row with too few columns is rejected as malformed", () => {
  const csv = "invoice_id,customer,customer_email,amount,due_date,status\nINV-1,Acme,a@b.com,100,2026-08-29\n";
  const r = parseInvoiceCsv(csv);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.some((e) => e.includes("Row 2")));
});
