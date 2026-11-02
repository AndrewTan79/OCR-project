import type { FieldKey } from "./parser";

export type RowStatus = "queued" | "processing" | "done" | "error";

export interface InvoiceRow {
  id: string;
  fileName: string;
  values: Record<FieldKey, string>;
  /** OCR confidence per field (0-100) at extraction time */
  confidence: Record<FieldKey, number>;
  /** fields the user has changed by hand */
  edited: Partial<Record<FieldKey, boolean>>;
  ocrConfidence: number;
  extractionIssues: string[];
  reviewed: boolean;
  status: RowStatus;
  progress: number;
  progressLabel: string;
  error?: string;
  source: "ocr" | "pdf-text" | "manual";
  pages: number;
  rawText: string;
  addedAt: number;
}

export type ReviewState = "ok" | "review" | "reviewed";
