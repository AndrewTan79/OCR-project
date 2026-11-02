import { test } from "node:test";
import assert from "node:assert/strict";
import { extractInvoice, findDate, parseMoney, validateValues } from "../src/parser.ts";

const SG_INVOICE = `
Brightline Office Supplies Pte Ltd
21 Tampines Street 92, Singapore 528891
GST Reg No: M2-0123456-7
TAX INVOICE
Invoice No: INV-2024-0457
Invoice Date: 15 March 2024
Due Date: 14 April 2024
Bill To:
Evolve Holdings Pte Ltd
8 Marina View
Description Qty Unit Price Amount
A4 Copier Paper (box of 5 reams) 10 32.00 320.00
Toner Cartridge HP 26A 2 89.50 179.00
Subtotal 499.00
GST 9% 44.91
Total Amount Due S$543.91
Thank you for your business
`;

test("extracts a typical Singapore tax invoice", () => {
  const { fields, issues } = extractInvoice(SG_INVOICE, 95);
  assert.equal(fields.vendor.value, "Brightline Office Supplies Pte Ltd");
  assert.equal(fields.invoiceNo.value, "INV-2024-0457");
  assert.equal(fields.date.value, "15/03/2024");
  assert.equal(fields.amount.value, "499.00");
  assert.equal(fields.gst.value, "44.91");
  assert.equal(fields.total.value, "543.91");
  assert.match(fields.description.value, /Copier Paper/);
  assert.deepEqual(issues, []);
  assert.ok(fields.total.confidence >= 90);
});

const US_STYLE = `
ACME CONSULTING LLC
Invoice # 10023
Date: 03/27/2024
Re: Website redesign phase 2
Net Amount 2,500.00
Tax 200.00
Grand Total $2,700.00
`;

test("handles month-first dates, # labels and Re: descriptions", () => {
  const { fields } = extractInvoice(US_STYLE);
  assert.equal(fields.vendor.value, "ACME CONSULTING LLC");
  assert.equal(fields.invoiceNo.value, "10023");
  assert.equal(fields.date.value, "27/03/2024");
  assert.equal(fields.amount.value, "2500.00");
  assert.equal(fields.gst.value, "200.00");
  assert.equal(fields.total.value, "2700.00");
  assert.equal(fields.description.value, "Website redesign phase 2");
});

test("infers amount from total and GST, flags low OCR quality", () => {
  const text = `Green Leaf Catering\nInvoice Number\nGL/7781\nDate 2024-06-02\nGST 18.00\nTotal 218.00`;
  const { fields, issues } = extractInvoice(text, 55);
  assert.equal(fields.invoiceNo.value, "GL/7781");
  assert.equal(fields.date.value, "02/06/2024");
  assert.equal(fields.amount.value, "200.00");
  assert.ok(issues.some((i) => i.includes("Low OCR")));
  assert.ok(fields.amount.confidence < 75);
});

test("flags arithmetic mismatch", () => {
  const { issues } = extractInvoice(`Shop Ltd\nInvoice No: A1\nDate: 01/02/2024\nSubtotal 100.00\nGST 9.00\nTotal 120.00`);
  assert.ok(issues.some((i) => i.includes("does not equal")));
});

test("helpers", () => {
  assert.equal(parseMoney("$1,234.56"), 1234.56);
  assert.equal(parseMoney("(12.00)"), -12);
  assert.equal(findDate("Mar 5, 2024"), "05/03/2024");
  assert.equal(findDate("5-Mar-24"), "05/03/2024");
  assert.equal(findDate("no date here 123"), null);
  const issues = validateValues({ vendor: "X", invoiceNo: "1", date: "31/02/2024", amount: "10", gst: "1", total: "12", description: "" });
  assert.ok(issues.some((i) => i.includes("DD/MM/YYYY")));
  assert.ok(issues.some((i) => i.includes("≠")));
});
