import PDFDocument from "pdfkit";

/**
 * Renders a SUPE incoming payment receipt as a PDF buffer.
 *
 * The receipt shows the credited amount, sender details, the journal
 * reference, and the double-entry ledger lines.
 */
export type IncomingPaymentReceipt = {
  reference: string;
  journalRef: string;
  amount: string;
  currency: string;
  format?: string | null;
  sender?: string | null;
  senderAccount?: string | null;
  valueDate?: string | null;
  fileName?: string | null;
  note?: string | null;
  destination?: string | null;
  status: string;
  createdAt: Date;
  lines: { debit: string; credit: string; accountCode: string }[];
};

export async function renderIncomingPaymentPdf(payment: IncomingPaymentReceipt): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk) => chunks.push(chunk));

  // pdfkit emits its output asynchronously, so the buffer must be assembled
  // only after the stream has fully flushed. Returning Buffer.concat(chunks)
  // synchronously (before 'end') produced a 0-byte file.
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const brandColor = "#003B70";
  const accentColor = "#E2B93B";
  const mutedColor = "#64748b";
  const lineColor = "#e2e8f0";

  // ── Header ──────────────────────────────────────
  doc
    .fillColor(brandColor)
    .font("Helvetica-Bold")
    .fontSize(22)
    .text("PrimeStack", 48, 48)
    .fillColor(accentColor)
    .fontSize(22)
    .text("Global Server Network", 48 + doc.widthOfString("PrimeStack") + 4, 48, { continued: false } as never);

  doc.moveDown(0.5);
  doc
    .fillColor(brandColor)
    .fontSize(18)
    .text("Incoming Payment Receipt");

  doc
    .fillColor(mutedColor)
    .fontSize(10)
    .text(`Generated: ${new Date().toISOString()}`, { align: "right" });

  // Status pill
  doc.moveDown(1);
  const statusText = payment.status.toUpperCase();
  doc
    .fillColor(payment.status === "CREDITED" || payment.status === "POSTED" ? "#166534" : "#92400e")
    .fontSize(11)
    .font("Helvetica-Bold")
    .text(`● ${statusText}`, { continued: false });

  doc.moveDown(1);

  // ── Divider ─────────────────────────────────────
  doc.strokeColor(lineColor).lineWidth(1).moveTo(48, doc.y).lineTo(48 + pageWidth, doc.y).stroke();
  doc.moveDown(1);

  // ── Amount highlight ────────────────────────────
  doc
    .fillColor(brandColor)
    .fontSize(28)
    .font("Helvetica-Bold")
    .text(`${payment.amount} ${payment.currency}`);

  doc.moveDown(0.5);

  // ── Details table ───────────────────────────────
  const details: { label: string; value: string }[] = [
    { label: "Payment Reference", value: payment.reference },
    { label: "Journal Entry Ref", value: payment.journalRef },
    { label: "Format", value: payment.format || "—" },
    { label: "Sender", value: payment.sender || "—" },
    { label: "Sender Account", value: payment.senderAccount || "—" },
    { label: "Value Date", value: payment.valueDate || "—" },
    { label: "File Name", value: payment.fileName || "—" },
    { label: "Destination", value: payment.destination || "—" },
    { label: "Note", value: payment.note || "—" },
    { label: "Recorded At", value: payment.createdAt.toISOString() },
  ];

  const labelWidth = 150;
  const valueWidth = pageWidth - labelWidth;
  let y = doc.y;

  for (const row of details) {
    doc
      .fillColor(mutedColor)
      .font("Helvetica")
      .fontSize(10)
      .text(row.label, 48, y, { width: labelWidth });

    doc
      .fillColor("#1a2332")
      .font("Helvetica")
      .fontSize(10)
      .text(row.value, 48 + labelWidth, y, { width: valueWidth });

    y += 22;
  }

  doc.y = y + 6;

  // ── Divider ─────────────────────────────────────
  doc.strokeColor(lineColor).lineWidth(1).moveTo(48, doc.y).lineTo(48 + pageWidth, doc.y).stroke();
  doc.moveDown(1);

  // ── Ledger entry ────────────────────────────────
  doc
    .fillColor(brandColor)
    .font("Helvetica-Bold")
    .fontSize(12)
    .text("Ledger Entry (Double-Entry)");

  doc.moveDown(0.5);

  // Table header
  const colW = [pageWidth * 0.5, pageWidth * 0.25, pageWidth * 0.25];
  let tableY = doc.y;

  doc
    .fillColor(brandColor)
    .font("Helvetica-Bold")
    .fontSize(10)
    .text("Account", 48, tableY, { width: colW[0] })
    .text("Debit", 48 + colW[0], tableY, { width: colW[1], align: "right" })
    .text("Credit", 48 + colW[0] + colW[1], tableY, { width: colW[2], align: "right" });

  tableY += 16;
  doc.strokeColor(brandColor).lineWidth(1).moveTo(48, tableY).lineTo(48 + pageWidth, tableY).stroke();
  tableY += 4;

  for (const line of payment.lines) {
    doc
      .fillColor("#1a2332")
      .font("Helvetica")
      .fontSize(10)
      .text(line.accountCode, 48, tableY, { width: colW[0] })
      .fillColor(line.debit !== "0" && line.debit !== "0.0000" ? "#b91c1c" : "#166534")
      .text(line.debit !== "0" && line.debit !== "0.0000" ? line.debit : "", 48 + colW[0], tableY, { width: colW[1], align: "right" })
      .fillColor(line.credit !== "0" && line.credit !== "0.0000" ? "#166534" : "#b91c1c")
      .text(line.credit !== "0" && line.credit !== "0.0000" ? line.credit : "", 48 + colW[0] + colW[1], tableY, { width: colW[2], align: "right" });

    tableY += 18;
  }

  doc.y = tableY + 12;

  // ── Divider ─────────────────────────────────────
  doc.strokeColor(lineColor).lineWidth(1).moveTo(48, doc.y).lineTo(48 + pageWidth, doc.y).stroke();
  doc.moveDown(1);

  // ── Footer ──────────────────────────────────────
  doc
    .fillColor(mutedColor)
    .fontSize(8)
    .font("Helvetica")
    .text(
      "This is an internal payment receipt generated by PrimeStack Global Server Network. " +
        "It records the ledger entry for the incoming payment and does not constitute a bank statement, " +
        "SWIFT message, or external settlement confirmation.",
      { align: "center" },
    );

  doc.end();

  return finished;
}
