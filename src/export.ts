import { parseMoney, toDate } from "./parser";
import { rowConfidence, reviewState, rowIssues, STATUS_LABELS, sumField } from "./review";
import type { InvoiceRow } from "./types";

export function exportFileName(ext: string): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  return `AP-Invoices-${stamp}.${ext}`;
}

const money = (v: string): number | null => {
  const n = parseMoney(v);
  return n === null ? null : Math.round(n * 100) / 100;
};

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ------------------------------------------------------------------ Excel

export async function buildExcel(rows: InvoiceRow[], user: string): Promise<Uint8Array> {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = `Evolve AP Invoice OCR (${user})`;
  wb.created = new Date();

  const ws = wb.addWorksheet("AP Invoices", {
    views: [{ state: "frozen", ySplit: 1 }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });

  ws.columns = [
    { header: "No.", key: "no", width: 6 },
    { header: "Status", key: "status", width: 14 },
    { header: "Vendor", key: "vendor", width: 34 },
    { header: "Invoice No.", key: "invoiceNo", width: 18 },
    { header: "Date", key: "date", width: 13 },
    { header: "Amount (excl. GST)", key: "amount", width: 18 },
    { header: "GST", key: "gst", width: 13 },
    { header: "Total", key: "total", width: 15 },
    { header: "Description", key: "description", width: 46 },
    { header: "Confidence %", key: "confidence", width: 13 },
    { header: "Review Notes", key: "notes", width: 40 },
    { header: "Source File", key: "file", width: 30 },
  ];

  const header = ws.getRow(1);
  header.height = 22;
  header.eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFE9CF94" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111114" } };
    c.alignment = { vertical: "middle" };
  });

  rows.forEach((r, i) => {
    const state = reviewState(r);
    const date = toDate(r.values.date);
    const row = ws.addRow({
      no: i + 1,
      status: STATUS_LABELS[state],
      vendor: r.values.vendor,
      invoiceNo: r.values.invoiceNo,
      date: date ?? r.values.date,
      amount: money(r.values.amount),
      gst: money(r.values.gst),
      total: money(r.values.total),
      description: r.values.description,
      confidence: r.source === "manual" ? null : rowConfidence(r),
      notes: state === "reviewed" ? "Reviewed by user" : rowIssues(r).join("; "),
      file: r.fileName,
    });
    row.getCell("date").numFmt = "dd/mm/yyyy";
    for (const k of ["amount", "gst", "total"]) row.getCell(k).numFmt = "#,##0.00";
    row.getCell("description").alignment = { wrapText: true, vertical: "top" };
    row.alignment = { vertical: "top" };
    const statusCell = row.getCell("status");
    if (state === "review") {
      statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } };
      statusCell.font = { bold: true, color: { argb: "FF92400E" } };
    } else {
      statusCell.font = { color: { argb: state === "reviewed" ? "FF96733A" : "FF047857" } };
    }
  });

  if (rows.length) {
    const first = 2, last = rows.length + 1;
    const totals = ws.addRow({
      vendor: "TOTAL",
      amount: { formula: `SUM(F${first}:F${last})`, result: sumField(rows, "amount") },
      gst: { formula: `SUM(G${first}:G${last})`, result: sumField(rows, "gst") },
      total: { formula: `SUM(H${first}:H${last})`, result: sumField(rows, "total") },
    });
    totals.font = { bold: true };
    totals.eachCell((c) => {
      c.border = { top: { style: "thin" }, bottom: { style: "double" } };
    });
    for (const k of ["amount", "gst", "total"]) totals.getCell(k).numFmt = "#,##0.00";
  }
  ws.autoFilter = { from: "A1", to: `L${Math.max(1, rows.length + 1)}` };

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

// ------------------------------------------------------------------ PDF

export async function buildPdf(rows: InvoiceRow[], user: string): Promise<Uint8Array> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  // Header band
  doc.setFillColor(13, 13, 15);
  doc.rect(0, 0, pageW, 64, "F");
  doc.setFillColor(212, 178, 106);
  doc.rect(0, 64, pageW, 1.5, "F");
  doc.setTextColor(233, 207, 148);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("AP Invoice Register", 36, 32);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(200, 192, 176);
  doc.text("Evolve AP Invoice OCR", 36, 50);
  const generated = `Generated ${new Date().toLocaleString("en-GB")} by ${user}`;
  doc.text(generated, pageW - 36 - doc.getTextWidth(generated), 32);

  const needsReview = rows.filter((r) => reviewState(r) === "review").length;
  const summary = `${rows.length} invoice${rows.length === 1 ? "" : "s"}   •   ${needsReview} need review   •   Grand total ${fmt(sumField(rows, "total"))}`;
  doc.text(summary, pageW - 36 - doc.getTextWidth(summary), 50);

  const body = rows.map((r, i) => {
    const st = reviewState(r);
    const n = (v: string) => {
      const m = money(v);
      return m === null ? v : fmt(m);
    };
    return [
      String(i + 1),
      STATUS_LABELS[st],
      r.values.vendor,
      r.values.invoiceNo,
      r.values.date,
      n(r.values.amount),
      n(r.values.gst),
      n(r.values.total),
      r.values.description,
    ];
  });

  autoTable(doc, {
    startY: 84,
    margin: { left: 36, right: 36, bottom: 40 },
    head: [["No.", "Status", "Vendor", "Invoice No.", "Date", "Amount", "GST", "Total", "Description"]],
    body,
    foot: rows.length
      ? [["", "", "TOTAL", "", "", fmt(sumField(rows, "amount")), fmt(sumField(rows, "gst")), fmt(sumField(rows, "total")), ""]]
      : undefined,
    theme: "grid",
    styles: { font: "helvetica", fontSize: 8.5, cellPadding: 5, lineColor: [226, 232, 240], lineWidth: 0.5, textColor: [30, 41, 59], overflow: "linebreak" },
    headStyles: { fillColor: [24, 23, 27], textColor: [233, 207, 148], fontStyle: "bold" },
    footStyles: { fillColor: [247, 242, 230], textColor: [60, 45, 15], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [250, 250, 252] },
    columnStyles: {
      0: { cellWidth: 28, halign: "center" },
      1: { cellWidth: 72 },
      2: { cellWidth: 140 },
      3: { cellWidth: 80 },
      4: { cellWidth: 62 },
      5: { cellWidth: 68, halign: "right" },
      6: { cellWidth: 56, halign: "right" },
      7: { cellWidth: 68, halign: "right" },
      8: { cellWidth: "auto" },
    },
    didParseCell: (data) => {
      if (data.section !== "body" && data.column.index >= 5 && data.column.index <= 7) data.cell.styles.halign = "right";
      if (data.section !== "body" || data.column.index !== 1) return;
      const v = String(data.cell.raw);
      if (v === STATUS_LABELS.review) {
        data.cell.styles.fillColor = [254, 243, 199];
        data.cell.styles.textColor = [146, 64, 14];
        data.cell.styles.fontStyle = "bold";
      } else if (v === STATUS_LABELS.reviewed) {
        data.cell.styles.textColor = [150, 115, 50];
      } else {
        data.cell.styles.textColor = [4, 120, 87];
      }
    },
  });

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text("Values extracted by OCR and reviewed in Evolve AP Invoice OCR.", 36, pageH - 20);
    const label = `Page ${p} of ${pages}`;
    doc.text(label, pageW - 36 - doc.getTextWidth(label), pageH - 20);
  }

  return new Uint8Array(doc.output("arraybuffer"));
}
