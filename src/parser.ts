// Invoice field extraction from OCR / PDF text.
// Pure functions only (no DOM) so it can be unit tested with Node.

export type FieldKey =
  | "vendor"
  | "invoiceNo"
  | "date"
  | "amount"
  | "gst"
  | "total"
  | "description";

export const FIELD_KEYS: FieldKey[] = [
  "vendor",
  "invoiceNo",
  "date",
  "amount",
  "gst",
  "total",
  "description",
];

export const REQUIRED_FIELDS: FieldKey[] = ["vendor", "invoiceNo", "date", "total"];
export const MONEY_FIELDS: FieldKey[] = ["amount", "gst", "total"];

export interface FieldResult {
  value: string;
  /** 0-100. 0 means not found. */
  confidence: number;
}

export interface Extraction {
  fields: Record<FieldKey, FieldResult>;
  issues: string[];
}

// ---------------------------------------------------------------- helpers

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?";

const MONEY_RE =
  /(?<![\w.,\/-])(?:[A-Z]{0,3}\$|RM|SGD|USD|AUD|NZD|MYR|EUR|GBP)?\s?(\(?-?(?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2}))\)?(?![\d%]|\s*%)/gi;

/** Parse "1,234.56", "$1,234.56", "(12.00)" etc. into a number. */
export function parseMoney(input: string): number | null {
  if (!input) return null;
  let s = String(input).trim();
  const negative = /^\(.*\)$/.test(s) || s.includes("-");
  s = s.replace(/[^\d.,]/g, "");
  if (!s) return null;
  // "1.234,56" (European) -> treat comma as decimal when it is the last separator with 2 digits
  if (/,\d{2}$/.test(s) && s.indexOf(".") !== -1 && s.lastIndexOf(",") > s.lastIndexOf(".")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

export function formatMoney(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** All money values on a line (left to right). */
export function moneyValues(line: string): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(MONEY_RE)) {
    const v = parseMoney(m[1]);
    if (v !== null) out.push(v);
  }
  return out;
}

function normaliseText(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .replace(/[|]/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .split("\n")
    .map((l) => l.replace(/\t/g, "  ").replace(/ {3,}/g, "  ").trim())
    .filter((l) => l.length > 0);
}

const pad = (n: number) => String(n).padStart(2, "0");

function validDate(d: number, m: number, y: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  if (y < 1990 || y > 2100) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getMonth() === m - 1;
}

function fixYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

/** Finds the first date in a string and returns it as DD/MM/YYYY. */
export function findDate(line: string): string | null {
  let m: RegExpMatchArray | null;

  // 2024-03-15 / 2024/03/15
  m = line.match(/\b(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (validDate(d, mo, y)) return `${pad(d)}/${pad(mo)}/${y}`;
  }

  // 15 March 2024 / 15-Mar-24 / 15th Mar, 2024
  m = line.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-/]*${MONTH_RE}[\\s,\\-/]*(\\d{4}|\\d{2})\\b`, "i"));
  if (m) {
    const d = +m[1], mo = MONTHS[m[2].toLowerCase()], y = fixYear(+m[3]);
    if (validDate(d, mo, y)) return `${pad(d)}/${pad(mo)}/${y}`;
  }

  // March 15, 2024
  m = line.match(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i"));
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()], d = +m[2], y = +m[3];
    if (validDate(d, mo, y)) return `${pad(d)}/${pad(mo)}/${y}`;
  }

  // 15/03/2024, 15-03-24, 15.03.2024  (day-first, swapped if clearly month-first)
  m = line.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})\b/);
  if (m) {
    let d = +m[1], mo = +m[2];
    const y = fixYear(+m[3]);
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    if (validDate(d, mo, y)) return `${pad(d)}/${pad(mo)}/${y}`;
  }
  return null;
}

/** Converts DD/MM/YYYY into a JS Date (or null). */
export function toDate(value: string): Date | null {
  const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = +m[1], mo = +m[2], y = +m[3];
  if (!validDate(d, mo, y)) return null;
  return new Date(Date.UTC(y, mo - 1, d));
}

// ---------------------------------------------------------------- fields

const notFound = (): FieldResult => ({ value: "", confidence: 0 });

const BILL_TO_RE = /\b(bill(?:ed)?\s+to|ship(?:ped)?\s+to|sold\s+to|deliver(?:ed|y)?\s+to|customer|client|attention|attn)\b|^to\s*:/i;
const COMPANY_RE =
  /\b(pte\.?\s*ltd|pty\.?\s*ltd|sdn\.?\s*bhd|ltd|limited|l\.?l\.?c|inc|corp(?:oration)?|company|co\.|gmbh|plc|llp|enterprises?|trading|holdings|group|solutions|services|studio|consulting)\b\.?/i;
const VENDOR_BLACKLIST =
  /(invoice|receipt|statement|quotation|date|page|bill|ship|\bno\b|number|total|gst|vat|reg|abn|uen|acn|phone|tel|fax|mobile|e-?mail|@|www\.|https?:|street|\bst\b|road|\brd\b|avenue|\bave\b|blvd|suite|level|floor|singapore \d|postal|due|terms|account|bank|swift|qty|description|amount|balance|paid)/i;

function cleanVendor(v: string): string {
  return v
    .replace(/^(from|vendor|supplier|seller|bill\s+from|issued\s+by|company(\s+name)?)\s*[:\-]\s*/i, "")
    .replace(/\s{2,}.*$/, "")
    .replace(/\s+(tax\s+invoice|invoice|receipt|statement|quotation)\b.*$/i, "")
    .replace(/[,;:.\-]+$/, "")
    .trim();
}

function extractVendor(lines: string[]): FieldResult {
  for (const line of lines.slice(0, 40)) {
    const m = line.match(/^(?:from|vendor|supplier|seller|bill\s+from|issued\s+by|company\s+name)\s*[:\-]\s*(.{3,})$/i);
    if (m) return { value: cleanVendor(m[1]), confidence: 90 };
  }

  const billToIdx = lines.findIndex((l) => BILL_TO_RE.test(l));
  const inBillTo = (i: number) => billToIdx !== -1 && i >= billToIdx && i <= billToIdx + 4;
  const top = lines.slice(0, 15);

  for (let i = 0; i < top.length; i++) {
    if (inBillTo(i)) continue;
    const line = top[i];
    if (COMPANY_RE.test(line) && !/(reg|registration|uen|abn|gst)\s*(no|number|#)?/i.test(line) && !line.includes("@")) {
      const v = cleanVendor(line.replace(/^(tax\s+)?invoice\s*/i, ""));
      if (v.length >= 3) return { value: v, confidence: i < billToIdx || billToIdx === -1 ? 85 : 70 };
    }
  }

  for (let i = 0; i < Math.min(lines.length, 6); i++) {
    if (inBillTo(i)) continue;
    const line = lines[i];
    const letters = (line.match(/[a-z]/gi) || []).length;
    if (letters < 3 || letters / line.length < 0.6) continue;
    if (VENDOR_BLACKLIST.test(line)) continue;
    return { value: cleanVendor(line), confidence: 60 };
  }
  return notFound();
}

const INV_TOKEN = "([A-Z0-9][A-Z0-9\\-\\/_.]*\\d[A-Z0-9\\-\\/_.]*|\\d[A-Z0-9\\-\\/_.]*)";

function cleanToken(t: string): string {
  return t.replace(/[.,;:\/\-_]+$/, "").trim();
}

function extractInvoiceNo(lines: string[]): FieldResult {
  const labelled = new RegExp(
    `\\b(?:tax\\s+)?(?:invoice|inv|bill|receipt|document|doc)\\.?\\s*(?:no\\.?|number|num|nbr|#|ref(?:erence)?)\\s*[:.#]?\\s*${INV_TOKEN}`,
    "i",
  );
  const shortLabel = new RegExp(`\\b(?:invoice|inv)\\.?\\s*[:#]\\s*${INV_TOKEN}`, "i");
  const labelOnly = /\b(?:tax\s+)?(?:invoice|inv)\.?\s*(?:no\.?|number|num|#)\s*[:.#]?\s*$/i;
  const tokenRe = /\b(INV[-\/]?\d[\w\-\/]*)\b/i;

  for (const line of lines) {
    const m = line.match(labelled);
    if (m) return { value: cleanToken(m[1]), confidence: 92 };
  }
  for (const line of lines) {
    const m = line.match(shortLabel);
    if (m) return { value: cleanToken(m[1]), confidence: 85 };
  }
  for (let i = 0; i < lines.length - 1; i++) {
    if (labelOnly.test(lines[i])) {
      const m = lines[i + 1].match(new RegExp(`^${INV_TOKEN}`, "i"));
      if (m) return { value: cleanToken(m[1]), confidence: 78 };
    }
  }
  for (const line of lines) {
    const m = line.match(tokenRe);
    if (m) return { value: cleanToken(m[1]), confidence: 72 };
  }
  return notFound();
}

function extractDate(lines: string[]): FieldResult {
  const label = /\b(invoice\s+date|inv\.?\s+date|date\s+of\s+(issue|invoice)|issue(d)?\s+(date|on)|tax\s+point|billing\s+date|date)\b/i;
  const dueLabel = /\b(due|expiry|expires|delivery|ship(ping)?|order\s+date|period|from|to)\b/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!label.test(line)) continue;
    // Prefer text after the label on the same line
    const afterLabel = line.slice(line.search(label));
    if (dueLabel.test(afterLabel.split(/\s{2,}/)[0]) && !/invoice\s+date/i.test(afterLabel)) continue;
    const d = findDate(afterLabel) ?? (i + 1 < lines.length ? findDate(lines[i + 1]) : null);
    if (d) return { value: d, confidence: /invoice\s+date|date\s+of\s+issue|issue/i.test(line) ? 94 : 88 };
  }
  for (const line of lines) {
    if (/\bdue\b/i.test(line)) continue;
    const d = findDate(line);
    if (d) return { value: d, confidence: 65 };
  }
  return notFound();
}

interface AmountHit {
  value: number;
  index: number;
}

function amountsForLabel(lines: string[], include: RegExp, exclude?: RegExp): AmountHit[] {
  const hits: AmountHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(include);
    if (!m || m.index === undefined) continue;
    if (exclude && exclude.test(line)) continue;
    const after = line.slice(m.index + m[0].length);
    let values = moneyValues(after);
    if (values.length === 0 && i + 1 < lines.length) {
      const next = lines[i + 1];
      // value on its own on the following line
      if (/^[^a-z]*$/i.test(next.replace(/\b(SGD|USD|AUD|NZD|MYR|RM|EUR|GBP)\b/gi, ""))) values = moneyValues(next);
    }
    if (values.length) hits.push({ value: values[values.length - 1], index: i });
  }
  return hits;
}

const SUBTOTAL_RE =
  /\b(sub[\s-]?total|amount\s+(before|excl(?:uding)?\.?|exclusive\s+of)\s+(gst|tax|vat)|total\s+(excl(?:uding)?\.?|before|exclusive\s+of|ex\.?)\s*(gst|tax|vat)?|net\s+(amount|total)|total\s+before\s+tax|taxable\s+(amount|value))\b/i;
const GST_RE = /\b(gst|vat|sales\s+tax|service\s+tax|tax)\b/i;
const GST_EXCLUDE =
  /(reg(istration|\.)?\b|\bno\.?\s*[:#]|tax\s+invoice|\bincl|inclusive|\bexcl|exclusive|before|after|\babn\b|\buen\b|sub[\s-]?total|amount\s+due|grand|payable|tax\s+id|id\s*no)/i;
const STRONG_TOTAL_RE =
  /\b(grand\s+total|total\s+(amount\s+)?(due|payable)|amount\s+(due|payable)|balance\s+(due|payable)|total\s+(incl(?:uding)?\.?|inclusive\s+of)\s*(gst|tax|vat)?|invoice\s+total|total\s+amount|total\s+\(?incl)/i;
const TOTAL_RE = /\btotal\b/i;
const TOTAL_EXCLUDE = /(sub[\s-]?total|excl|before|exclusive|\btotal\s+(gst|vat|tax)\b|qty|quantity|items|hours|units|weight|discount)/i;

function extractAmounts(lines: string[]): { amount: FieldResult; gst: FieldResult; total: FieldResult } {
  const sub = amountsForLabel(lines, SUBTOTAL_RE);
  const gst = amountsForLabel(lines, GST_RE, GST_EXCLUDE).filter((h) => !SUBTOTAL_RE.test(lines[h.index]));
  const strong = amountsForLabel(lines, STRONG_TOTAL_RE);
  const weak = amountsForLabel(lines, TOTAL_RE, TOTAL_EXCLUDE).filter((h) => !STRONG_TOTAL_RE.test(lines[h.index]));

  let total: FieldResult = notFound();
  if (strong.length) {
    const best = strong.reduce((a, b) => (b.value > a.value ? b : a));
    total = { value: formatMoney(best.value), confidence: 92 };
  } else if (weak.length) {
    const best = weak[weak.length - 1];
    total = { value: formatMoney(best.value), confidence: 80 };
  }

  const amount: FieldResult = sub.length ? { value: formatMoney(sub[sub.length - 1].value), confidence: 88 } : notFound();
  const gstField: FieldResult = gst.length ? { value: formatMoney(gst[gst.length - 1].value), confidence: 86 } : notFound();
  return { amount, gst: gstField, total };
}

const DESC_HEADER_RE = /^(?:s\/?no\.?\s+|no\.?\s+|#\s+|item\s+)?(description|particulars|details|item\s+description|services?|product)\b/i;
const DESC_STOP_RE =
  /\b(sub[\s-]?total|total|gst|vat|tax|amount\s+due|balance|payment|notes?|terms|thank\s+you|bank|remarks?)\b/i;

function cleanDescription(line: string): string {
  let s = line.split(/\s{2,}(?=[\d$(])/)[0];
  // drop trailing qty / price / amount columns
  const trailing = /\s+(?:[A-Z]{0,3}\$)?\(?-?[\d.,]+\)?\s*(?:x|pcs|hrs?|units?|ea|nos?)?\.?$/i;
  while (trailing.test(s)) s = s.replace(trailing, "");
  return s
    .replace(/^\s*(\d+[.)]|[-•*])\s*/, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[,;:\-\s]+$/, "")
    .trim();
}

function extractDescription(lines: string[]): FieldResult {
  for (const line of lines) {
    const m = line.match(/^(?:re|subject|project|for|purpose|being)\s*[:\-]\s*(.{3,})$/i);
    if (m) return { value: m[1].trim(), confidence: 85 };
  }

  const headerIdx = lines.findIndex((l) => DESC_HEADER_RE.test(l));
  if (headerIdx !== -1) {
    const header = lines[headerIdx];
    // "Description: Something" on one line
    const inline = header.match(/^(?:description|particulars|details)\s*[:\-]\s*(.{3,})$/i);
    if (inline) return { value: inline[1].trim(), confidence: 85 };

    const items: string[] = [];
    for (let i = headerIdx + 1; i < lines.length && items.length < 3; i++) {
      if (DESC_STOP_RE.test(lines[i])) break;
      const desc = cleanDescription(lines[i]);
      if ((desc.match(/[a-z]/gi) || []).length >= 3) items.push(desc);
    }
    if (items.length) return { value: items.join("; "), confidence: 84 };
  }

  // Fallback: first line with words followed by a money amount, before the totals block.
  const totalsIdx = lines.findIndex((l) => SUBTOTAL_RE.test(l) || STRONG_TOTAL_RE.test(l));
  const end = totalsIdx === -1 ? lines.length : totalsIdx;
  for (let i = 0; i < end; i++) {
    const line = lines[i];
    if (!moneyValues(line).length) continue;
    if (DESC_STOP_RE.test(line) || /\b(date|invoice|no\.|tel|phone|fax)\b/i.test(line)) continue;
    const desc = cleanDescription(line);
    if ((desc.match(/[a-z]/gi) || []).length >= 4) return { value: desc, confidence: 55 };
  }
  return notFound();
}

// ---------------------------------------------------------------- main

/**
 * Extract invoice fields from raw text.
 * @param text OCR or PDF text
 * @param ocrConfidence mean OCR confidence 0-100 (100 for digital PDFs)
 */
export function extractInvoice(text: string, ocrConfidence = 100): Extraction {
  const lines = normaliseText(text);
  const issues: string[] = [];

  const { amount, gst, total } = extractAmounts(lines);
  const fields: Record<FieldKey, FieldResult> = {
    vendor: extractVendor(lines),
    invoiceNo: extractInvoiceNo(lines),
    date: extractDate(lines),
    amount,
    gst,
    total,
    description: extractDescription(lines),
  };

  // Cross-check money fields: Amount + GST should equal Total.
  // Scale by OCR quality: poor scans lower every field's confidence.
  const factor = 0.55 + 0.45 * Math.max(0, Math.min(100, ocrConfidence)) / 100;
  for (const k of FIELD_KEYS) {
    fields[k].confidence = fields[k].value ? Math.round(fields[k].confidence * factor) : 0;
  }

  const a = parseMoney(fields.amount.value);
  const g = parseMoney(fields.gst.value);
  const t = parseMoney(fields.total.value);
  if (a !== null && g !== null && t !== null) {
    if (Math.abs(a + g - t) <= 0.05 && t > 0) {
      // Three independently read numbers that reconcile are very likely correct.
      for (const k of MONEY_FIELDS) fields[k].confidence = Math.max(fields[k].confidence, 95);
    } else {
      issues.push("Amount + GST does not equal Total");
      for (const k of MONEY_FIELDS) fields[k].confidence = Math.min(fields[k].confidence, 60);
    }
  } else if (t !== null && g !== null && a === null && t - g >= 0) {
    fields.amount = { value: formatMoney(t - g), confidence: Math.round(72 * factor) };
  } else if (a !== null && g !== null && t === null) {
    fields.total = { value: formatMoney(a + g), confidence: Math.round(72 * factor) };
  } else if (a !== null && t !== null && g === null && t - a >= 0) {
    fields.gst = { value: formatMoney(t - a), confidence: Math.round(70 * factor) };
  } else if (t !== null && a === null && g === null) {
    // No GST on the invoice: amount equals total, GST zero.
    fields.amount = { value: fields.total.value, confidence: Math.round(65 * factor) };
    fields.gst = { value: "0.00", confidence: Math.round(60 * factor) };
    issues.push("No GST line found");
  }

  if (ocrConfidence < 70) issues.push(`Low OCR quality (${Math.round(ocrConfidence)}%)`);
  return { fields, issues };
}

// ---------------------------------------------------------------- review rules

export const REVIEW_THRESHOLD = 75;

/** Validation issues for the current (possibly user-edited) values. */
export function validateValues(values: Record<FieldKey, string>): string[] {
  const issues: string[] = [];
  const labels: Record<FieldKey, string> = {
    vendor: "Vendor",
    invoiceNo: "Invoice No.",
    date: "Date",
    amount: "Amount",
    gst: "GST",
    total: "Total",
    description: "Description",
  };
  const missing = REQUIRED_FIELDS.filter((k) => !values[k].trim());
  if (missing.length) issues.push(`Missing: ${missing.map((k) => labels[k]).join(", ")}`);

  for (const k of MONEY_FIELDS) {
    if (values[k].trim() && parseMoney(values[k]) === null) issues.push(`${labels[k]} is not a number`);
  }
  if (values.date.trim() && !toDate(values.date)) issues.push("Date should be DD/MM/YYYY");

  const a = parseMoney(values.amount), g = parseMoney(values.gst), t = parseMoney(values.total);
  if (a !== null && g !== null && t !== null && Math.abs(a + g - t) > 0.05) {
    issues.push(`Amount + GST (${formatMoney(a + g)}) ≠ Total (${formatMoney(t)})`);
  }
  return issues;
}
