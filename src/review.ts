import { FIELD_KEYS, REQUIRED_FIELDS, REVIEW_THRESHOLD, parseMoney, validateValues, type FieldKey } from "./parser";
import type { InvoiceRow, ReviewState } from "./types";

/** Effective confidence: hand-edited fields are trusted. */
export function fieldConfidence(row: InvoiceRow, key: FieldKey): number {
  if (row.edited[key]) return 100;
  if (row.source === "manual") return row.values[key] ? 100 : 0;
  return row.confidence[key];
}

export function isLowConfidence(row: InvoiceRow, key: FieldKey): boolean {
  if (row.status !== "done" || row.reviewed) return false;
  const v = row.values[key].trim();
  if (!v) return REQUIRED_FIELDS.includes(key);
  return fieldConfidence(row, key) < REVIEW_THRESHOLD;
}

export function rowIssues(row: InvoiceRow): string[] {
  if (row.status === "error") return [row.error || "Could not read file"];
  if (row.status !== "done") return [];
  const issues = validateValues(row.values);
  // Description is free text: it is highlighted when uncertain but does not flag the whole row.
  const low = FIELD_KEYS.filter(
    (k) => k !== "description" && row.values[k].trim() && fieldConfidence(row, k) < REVIEW_THRESHOLD,
  );
  if (low.length) issues.push(`Low confidence: ${low.map(labelOf).join(", ")}`);
  for (const i of row.extractionIssues) {
    if (/Low OCR/.test(i) && !issues.includes(i)) issues.push(i);
  }
  return issues;
}

export function reviewState(row: InvoiceRow): ReviewState {
  if (row.reviewed) return "reviewed";
  return rowIssues(row).length ? "review" : "ok";
}

/** Overall row confidence: average over required + money fields. */
export function rowConfidence(row: InvoiceRow): number {
  if (row.status !== "done") return 0;
  const keys: FieldKey[] = ["vendor", "invoiceNo", "date", "amount", "gst", "total"];
  const sum = keys.reduce((s, k) => s + fieldConfidence(row, k), 0);
  return Math.round(sum / keys.length);
}

export function labelOf(key: FieldKey): string {
  return COLUMN_LABELS[key];
}

export const COLUMN_LABELS: Record<FieldKey, string> = {
  vendor: "Vendor",
  invoiceNo: "Invoice No.",
  date: "Date",
  amount: "Amount",
  gst: "GST",
  total: "Total",
  description: "Description",
};

export const STATUS_LABELS: Record<ReviewState, string> = {
  ok: "OK",
  review: "Needs Review",
  reviewed: "Reviewed",
};

export function sumField(rows: InvoiceRow[], key: FieldKey): number {
  return rows.reduce((s, r) => s + (parseMoney(r.values[key]) ?? 0), 0);
}
