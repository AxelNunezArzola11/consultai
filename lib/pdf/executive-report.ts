/**
 * Executive PDF Report Generator
 *
 * Generates a self-contained executive PDF report using pdf-lib (already in
 * package.json).  No browser-only APIs — safe to call from a client component
 * via dynamic import so the heavy pdf-lib is code-split.
 *
 * Report sections:
 *   1. Cover page — project title, export date
 *   2. Candidate Trust Score & Stack Match breakdown
 *   3. CAN/CAN'T-DO Matrix with GitHub source links
 *   4. Project milestone timeline
 *   5. AI Vetting summary and human-review disclaimer
 */

import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import type { MatrixEntry, Signal, ScoreBreakdown } from "@/lib/vetting/signals";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PdfCandidate {
  id: string;
  name: string;
  email: string;
  githubHandle: string | null;
  trustScore: number;
  scoreBreakdown: ScoreBreakdown | null;
  matrix: MatrixEntry[];
  signals: Signal[];
}

export interface PdfMilestone {
  id: string;
  title: string;
  startDate: string | null;
  dueDate: string | null;
  status: string;
}

export interface ExecutivePdfOptions {
  projectTitle: string;
  projectId: string;
  candidates: PdfCandidate[];
  milestones: PdfMilestone[];
  humanReviewNotice: string;
  exportedBy?: string;
}

// ── Colour palette ────────────────────────────────────────────────────────────

const COLOR = {
  navy:    rgb(0.10, 0.14, 0.22),
  primary: rgb(0.23, 0.51, 0.96),
  muted:   rgb(0.45, 0.52, 0.60),
  border:  rgb(0.87, 0.89, 0.92),
  bg:      rgb(0.97, 0.97, 0.99),
  white:   rgb(1.00, 1.00, 1.00),
  emerald: rgb(0.02, 0.71, 0.45),
  amber:   rgb(0.95, 0.62, 0.10),
  rose:    rgb(0.94, 0.27, 0.27),
  slate:   rgb(0.47, 0.54, 0.60),
};

// ── Layout constants ──────────────────────────────────────────────────────────

const PAGE_W  = 595;   // A4 width in pts
const PAGE_H  = 842;   // A4 height in pts
const MARGIN  = 48;
const COL_W   = PAGE_W - MARGIN * 2;

// ── Drawing helpers ───────────────────────────────────────────────────────────

function drawRect(
  page: PDFPage,
  x: number, y: number, w: number, h: number,
  fill = COLOR.bg,
  stroke?: { color: typeof COLOR.border; width: number },
) {
  page.drawRectangle({ x, y, width: w, height: h, color: fill });
  if (stroke) {
    page.drawRectangle({ x, y, width: w, height: h, borderColor: stroke.color, borderWidth: stroke.width, color: undefined });
  }
}

function drawLine(page: PDFPage, x1: number, y1: number, x2: number, y2: number, color = COLOR.border, thick = 0.5) {
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: thick, color });
}

function drawText(
  page: PDFPage,
  text: string,
  x: number, y: number,
  font: PDFFont,
  size: number,
  color = COLOR.navy,
  maxWidth?: number,
): number {
  // Truncate text to maxWidth if given
  let display = text;
  if (maxWidth) {
    while (display.length > 0 && font.widthOfTextAtSize(display, size) > maxWidth) {
      display = display.slice(0, -1);
    }
    if (display !== text) display = display.slice(0, -1) + "…";
  }
  page.drawText(display, { x, y, font, size, color });
  return font.widthOfTextAtSize(display, size);
}

// Wrap text into lines that fit maxWidth; returns lines used.
function drawWrappedText(
  page: PDFPage,
  text: string,
  x: number, y: number,
  font: PDFFont,
  size: number,
  maxWidth: number,
  lineHeight: number,
  color = COLOR.navy,
): number {
  const words = text.split(" ");
  let line   = "";
  let curY   = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
      page.drawText(line, { x, y: curY, font, size, color });
      curY -= lineHeight;
      line  = word;
    } else {
      line = test;
    }
  }
  if (line) {
    page.drawText(line, { x, y: curY, font, size, color });
    curY -= lineHeight;
  }
  return y - curY; // total height consumed
}

// ── Score bar helper ──────────────────────────────────────────────────────────

function drawScoreBar(
  page: PDFPage,
  x: number, y: number, w: number, h: number,
  pct: number, // 0–100
  label: string,
  font: PDFFont, labelFont: PDFFont,
  size = 8,
) {
  const fillPct = Math.min(100, Math.max(0, pct)) / 100;
  const barColor = pct >= 75 ? COLOR.emerald : pct >= 40 ? COLOR.amber : COLOR.rose;

  // Track
  drawRect(page, x, y, w, h, COLOR.border);
  // Fill
  if (fillPct > 0) {
    drawRect(page, x, y, w * fillPct, h, barColor);
  }
  // Label
  drawText(page, label, x, y + h + 3, font, size, COLOR.muted);
  drawText(page, `${Math.round(pct)}%`, x + w - 24, y + h + 3, labelFont, size, COLOR.navy);
}

// ── Page factory ──────────────────────────────────────────────────────────────

function addPage(doc: PDFDocument) {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  return { page, y: PAGE_H - MARGIN };
}

function ensureSpace(
  doc: PDFDocument,
  y: number,
  needed: number,
  font: PDFFont,
): { page: PDFPage; y: number } | null {
  if (y - needed >= MARGIN) return null;
  const { page, y: newY } = addPage(doc);
  drawPageFooter(page, font, doc.getPageCount());
  return { page, y: newY };
}

function drawPageFooter(page: PDFPage, font: PDFFont, pageNum: number) {
  drawLine(page, MARGIN, MARGIN - 6, PAGE_W - MARGIN, MARGIN - 6);
  page.drawText(
    `ConsultAI · Executive Report — Page ${pageNum}   |   AI-generated analysis. Human review required before any hiring decision.`,
    { x: MARGIN, y: MARGIN - 18, font, size: 7, color: COLOR.muted }
  );
}

// ── Main export function ──────────────────────────────────────────────────────

export async function generateExecutivePdf(opts: ExecutivePdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular   = await doc.embedFont(StandardFonts.Helvetica);
  const bold      = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono      = await doc.embedFont(StandardFonts.Courier);

  doc.setTitle(`Executive Report — ${opts.projectTitle}`);
  doc.setAuthor("ConsultAI");
  doc.setCreationDate(new Date());

  // ── Cover page ─────────────────────────────────────────────────────────────
  {
    const { page } = addPage(doc);

    // Header band
    drawRect(page, 0, PAGE_H - 120, PAGE_W, 120, COLOR.navy);
    drawText(page, "EXECUTIVE REPORT", MARGIN, PAGE_H - 50, bold, 11, COLOR.primary);
    drawText(page, opts.projectTitle, MARGIN, PAGE_H - 72, bold, 22, COLOR.white);
    drawText(page, `ConsultAI · AI-Assisted Candidate Vetting`, MARGIN, PAGE_H - 92, regular, 10, rgb(0.7, 0.75, 0.85));

    // Meta info
    let metaY = PAGE_H - 150;
    const exportDate = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    drawText(page, `Exported:  ${exportDate}`, MARGIN, metaY, regular, 10, COLOR.muted); metaY -= 18;
    drawText(page, `Project ID: ${opts.projectId}`, MARGIN, metaY, mono, 9, COLOR.muted); metaY -= 18;
    if (opts.exportedBy) {
      drawText(page, `Prepared by: ${opts.exportedBy}`, MARGIN, metaY, regular, 10, COLOR.muted); metaY -= 18;
    }
    drawText(page, `Candidates reviewed: ${opts.candidates.length}`, MARGIN, metaY, regular, 10, COLOR.muted); metaY -= 18;
    drawText(page, `Milestones: ${opts.milestones.length}`, MARGIN, metaY, regular, 10, COLOR.muted); metaY -= 30;

    // Table of contents
    drawRect(page, MARGIN, metaY - 80, COL_W, 90, COLOR.bg);
    drawText(page, "CONTENTS", MARGIN + 12, metaY - 12, bold, 9, COLOR.primary);
    const sections = [
      "1.  Candidate Trust Score & Stack Match",
      "2.  CAN / CAN'T-DO Matrix with Evidence Links",
      "3.  Project Milestone Timeline",
      "4.  AI Vetting Summary & Human-Review Disclaimer",
    ];
    sections.forEach((s, i) => {
      drawText(page, s, MARGIN + 12, metaY - 28 - i * 14, regular, 9, COLOR.navy);
    });

    // Disclaimer band
    drawRect(page, 0, 60, PAGE_W, 60, rgb(1.0, 0.96, 0.88));
    page.drawText("⚠  This report contains AI-generated analysis only. All findings must be verified by a qualified human reviewer.", {
      x: MARGIN, y: 92, font: bold, size: 8.5, color: rgb(0.7, 0.4, 0.0)
    });
    page.drawText("Candidate attributes such as name, photo, gender, age, nationality, and location are NEVER used as scoring features.", {
      x: MARGIN, y: 75, font: regular, size: 8, color: rgb(0.6, 0.35, 0.0)
    });

    drawPageFooter(page, regular, 1);
  }

  // ── Section 1: Trust Scores ────────────────────────────────────────────────
  {
    let { page, y } = addPage(doc);
    drawPageFooter(page, regular, doc.getPageCount());

    // Section header
    drawRect(page, MARGIN, y - 28, COL_W, 26, COLOR.navy);
    drawText(page, "1.  CANDIDATE TRUST SCORE & STACK MATCH", MARGIN + 10, y - 18, bold, 10, COLOR.white);
    y -= 44;

    for (const c of opts.candidates) {
      const needed = 110;
      const overflow = ensureSpace(doc, y, needed, regular);
      if (overflow) { page = overflow.page; y = overflow.y; drawPageFooter(page, regular, doc.getPageCount()); }

      const trustPct = Math.round(c.trustScore * 100);
      const stackPct = Math.round(
        (c.scoreBreakdown?.bySignalType?.github_repo?.avgConfidence ?? c.trustScore) * 100
      );

      // Candidate card background
      drawRect(page, MARGIN, y - 90, COL_W, 88, COLOR.bg, { color: COLOR.border, width: 0.5 });

      // Name + handle
      drawText(page, c.name, MARGIN + 10, y - 16, bold, 11, COLOR.navy);
      if (c.githubHandle) {
        drawText(page, `github.com/${c.githubHandle}`, MARGIN + 10, y - 30, regular, 8, COLOR.primary);
      }
      drawText(page, c.email, MARGIN + 10, y - 42, regular, 8, COLOR.muted);

      // Trust score badge
      const badgeColor = trustPct >= 75 ? COLOR.emerald : trustPct >= 40 ? COLOR.amber : COLOR.rose;
      drawRect(page, PAGE_W - MARGIN - 72, y - 40, 70, 32, badgeColor);
      drawText(page, `${trustPct} pts`, PAGE_W - MARGIN - 56, y - 18, bold, 15, COLOR.white);
      drawText(page, "Trust Score", PAGE_W - MARGIN - 62, y - 30, regular, 7, COLOR.white);

      // Score bars
      const barX = MARGIN + 10;
      const barW = COL_W - 110;
      drawScoreBar(page, barX, y - 58, barW, 8, trustPct, "Overall Trust", regular, bold);
      drawScoreBar(page, barX, y - 74, barW, 8, stackPct,  "Stack Fit (GitHub)", regular, bold);

      // Score breakdown pills
      if (c.scoreBreakdown) {
        const types = Object.entries(c.scoreBreakdown.bySignalType);
        let pillX = MARGIN + 10;
        const pillY = y - 88;
        for (const [type, stat] of types.slice(0, 5)) {
          const pct = Math.round((stat?.avgConfidence ?? 0) * 100);
          const pillW = Math.max(60, regular.widthOfTextAtSize(`${type} ${pct}%`, 7) + 10);
          if (pillX + pillW > PAGE_W - MARGIN) break;
          drawRect(page, pillX, pillY, pillW, 12, rgb(0.92, 0.94, 0.98), { color: COLOR.border, width: 0.4 });
          drawText(page, `${type.replace("_", " ")} ${pct}%`, pillX + 4, pillY + 3, regular, 7, COLOR.navy);
          pillX += pillW + 4;
        }
      }

      y -= 100;
    }
  }

  // ── Section 2: CAN/CAN'T-DO Matrix ───────────────────────────────────────
  {
    let { page, y } = addPage(doc);
    drawPageFooter(page, regular, doc.getPageCount());

    drawRect(page, MARGIN, y - 28, COL_W, 26, COLOR.navy);
    drawText(page, "2.  CAN / CAN'T-DO MATRIX WITH EVIDENCE LINKS", MARGIN + 10, y - 18, bold, 10, COLOR.white);
    y -= 44;

    for (const c of opts.candidates) {
      const needed = 30 + c.matrix.length * 18;
      const overflow = ensureSpace(doc, y, needed, regular);
      if (overflow) { page = overflow.page; y = overflow.y; drawPageFooter(page, regular, doc.getPageCount()); }

      drawText(page, c.name, MARGIN, y, bold, 10, COLOR.navy);
      if (c.githubHandle) {
        drawText(page, ` · @${c.githubHandle}`, MARGIN + bold.widthOfTextAtSize(c.name, 10) + 2, y, regular, 9, COLOR.primary);
      }
      y -= 14;

      // Column headers
      drawLine(page, MARGIN, y - 1, PAGE_W - MARGIN, y - 1, COLOR.border, 0.5);
      drawText(page, "STATE",        MARGIN,       y - 10, bold, 7.5, COLOR.muted);
      drawText(page, "REQUIREMENT",  MARGIN + 60,  y - 10, bold, 7.5, COLOR.muted);
      drawText(page, "EVIDENCE URL", MARGIN + 280, y - 10, bold, 7.5, COLOR.muted);
      y -= 14;

      for (const entry of c.matrix) {
        const rowOverflow = ensureSpace(doc, y, 20, regular);
        if (rowOverflow) { page = rowOverflow.page; y = rowOverflow.y; drawPageFooter(page, regular, doc.getPageCount()); }

        const stateColors: Record<string, [typeof COLOR.emerald, string]> = {
          can:     [COLOR.emerald, "CAN"],
          partial: [COLOR.amber,   "PARTIAL"],
          no:      [COLOR.rose,    "CANNOT"],
          unknown: [COLOR.slate,   "UNKNOWN"],
        };
        const [stateColor, stateLabel] = stateColors[entry.state] ?? [COLOR.slate, entry.state.toUpperCase()];

        // State pill
        const pillW = bold.widthOfTextAtSize(stateLabel, 7) + 8;
        drawRect(page, MARGIN, y - 10, pillW, 11, stateColor);
        drawText(page, stateLabel, MARGIN + 4, y - 8, bold, 7, COLOR.white);

        // Requirement text
        drawText(page, entry.requirementDescription, MARGIN + 60, y - 8, regular, 8, COLOR.navy, 200);

        // Evidence URL from first matching signal
        const sig = c.signals.find((s) => s.requirementId === entry.requirementId);
        if (sig?.sourceUrl) {
          drawText(page, sig.sourceUrl, MARGIN + 280, y - 8, mono, 7, COLOR.primary, COL_W - 280);
        } else {
          drawText(page, "—", MARGIN + 280, y - 8, regular, 8, COLOR.muted);
        }

        drawLine(page, MARGIN, y - 12, PAGE_W - MARGIN, y - 12, COLOR.border, 0.3);
        y -= 17;
      }

      y -= 10;
    }
  }

  // ── Section 3: Milestone Timeline ────────────────────────────────────────
  {
    let { page, y } = addPage(doc);
    drawPageFooter(page, regular, doc.getPageCount());

    drawRect(page, MARGIN, y - 28, COL_W, 26, COLOR.navy);
    drawText(page, "3.  PROJECT MILESTONE TIMELINE", MARGIN + 10, y - 18, bold, 10, COLOR.white);
    y -= 44;

    if (opts.milestones.length === 0) {
      drawText(page, "No milestones configured for this project.", MARGIN, y, regular, 10, COLOR.muted);
    } else {
      // Table header
      const COL = { num: MARGIN, title: MARGIN + 24, start: MARGIN + 240, due: MARGIN + 330, status: MARGIN + 420 };
      drawRect(page, MARGIN, y - 14, COL_W, 14, rgb(0.90, 0.92, 0.96));
      ["#", "MILESTONE TITLE", "START", "DUE", "STATUS"].forEach((h, i) => {
        const xs = [COL.num, COL.title, COL.start, COL.due, COL.status];
        drawText(page, h, xs[i], y - 10, bold, 7.5, COLOR.navy);
      });
      y -= 16;

      for (const [i, m] of opts.milestones.entries()) {
        const rowOverflow = ensureSpace(doc, y, 18, regular);
        if (rowOverflow) { page = rowOverflow.page; y = rowOverflow.y; drawPageFooter(page, regular, doc.getPageCount()); }

        if (i % 2 === 0) drawRect(page, MARGIN, y - 13, COL_W, 13, COLOR.bg);
        const statusColors: Record<string, typeof COLOR.emerald> = {
          paid: COLOR.emerald, funded: COLOR.primary, disputed: COLOR.rose, planned: COLOR.slate,
        };
        const sCol = statusColors[m.status] ?? COLOR.slate;

        drawText(page, `M${i + 1}`, COL.num, y - 9, bold, 8, COLOR.muted);
        drawText(page, m.title, COL.title, y - 9, regular, 8.5, COLOR.navy, 190);
        drawText(page, m.startDate ?? "—", COL.start, y - 9, mono, 8, COLOR.muted);
        drawText(page, m.dueDate   ?? "—", COL.due,   y - 9, mono, 8, COLOR.muted);
        drawText(page, m.status.replace(/_/g, " ").toUpperCase(), COL.status, y - 9, bold, 7, sCol);

        drawLine(page, MARGIN, y - 13, PAGE_W - MARGIN, y - 13, COLOR.border, 0.3);
        y -= 15;
      }
    }
  }

  // ── Section 4: AI Summary & Disclaimer ────────────────────────────────────
  {
    let { page, y } = addPage(doc);
    drawPageFooter(page, regular, doc.getPageCount());

    drawRect(page, MARGIN, y - 28, COL_W, 26, COLOR.navy);
    drawText(page, "4.  AI VETTING SUMMARY & HUMAN-REVIEW DISCLAIMER", MARGIN + 10, y - 18, bold, 10, COLOR.white);
    y -= 44;

    // Summary table
    drawText(page, "Candidate Summary", MARGIN, y, bold, 10, COLOR.navy); y -= 16;
    drawLine(page, MARGIN, y, PAGE_W - MARGIN, y, COLOR.border);
    drawText(page, "Candidate", MARGIN, y - 10, bold, 8, COLOR.muted);
    drawText(page, "Trust", MARGIN + 200, y - 10, bold, 8, COLOR.muted);
    drawText(page, "Stack Fit", MARGIN + 260, y - 10, bold, 8, COLOR.muted);
    drawText(page, "CAN", MARGIN + 330, y - 10, bold, 8, COLOR.muted);
    drawText(page, "CANNOT", MARGIN + 360, y - 10, bold, 8, COLOR.muted);
    drawText(page, "Shortlist?", MARGIN + 410, y - 10, bold, 8, COLOR.muted);
    y -= 14;

    for (const c of opts.candidates) {
      const rowOverflow = ensureSpace(doc, y, 16, regular);
      if (rowOverflow) { page = rowOverflow.page; y = rowOverflow.y; drawPageFooter(page, regular, doc.getPageCount()); }

      const trustPct = Math.round(c.trustScore * 100);
      const stackPct = Math.round((c.scoreBreakdown?.bySignalType?.github_repo?.avgConfidence ?? c.trustScore) * 100);
      const canCount  = c.matrix.filter((m) => m.state === "can").length;
      const noCount   = c.matrix.filter((m) => m.state === "no").length;

      drawText(page, c.name, MARGIN, y - 9, regular, 8.5, COLOR.navy, 190);
      drawText(page, `${trustPct}%`, MARGIN + 200, y - 9, bold, 9, trustPct >= 75 ? COLOR.emerald : trustPct >= 40 ? COLOR.amber : COLOR.rose);
      drawText(page, `${stackPct}%`, MARGIN + 260, y - 9, regular, 8.5, COLOR.navy);
      drawText(page, String(canCount), MARGIN + 330, y - 9, bold, 9, COLOR.emerald);
      drawText(page, String(noCount),  MARGIN + 360, y - 9, bold, 9, COLOR.rose);
      drawLine(page, MARGIN, y - 12, PAGE_W - MARGIN, y - 12, COLOR.border, 0.3);
      y -= 14;
    }

    y -= 20;

    // Human-review disclaimer
    const disclaimerOverflow = ensureSpace(doc, y, 130, regular);
    if (disclaimerOverflow) { page = disclaimerOverflow.page; y = disclaimerOverflow.y; drawPageFooter(page, regular, doc.getPageCount()); }

    drawRect(page, MARGIN, y - 120, COL_W, 118, rgb(1.0, 0.96, 0.88), { color: rgb(0.85, 0.60, 0.10), width: 0.8 });
    drawText(page, "⚠  HUMAN-REVIEW DISCLAIMER", MARGIN + 12, y - 16, bold, 10, rgb(0.7, 0.40, 0.0));
    y -= 30;

    const disclaimerText = opts.humanReviewNotice ||
      "This report was generated by an AI system using publicly available information. All findings are indicative only and must be verified by a qualified human reviewer before any hiring, contracting, or business decision is made. The final decision rests with the company at all times.";
    drawWrappedText(page, disclaimerText, MARGIN + 12, y, regular, 8.5, COL_W - 24, 13, rgb(0.5, 0.30, 0.0));

    y -= 80;
    drawText(page, "AI Transparency Points:", MARGIN, y, bold, 9, COLOR.navy); y -= 14;
    const points = [
      "• Trust scores are computed deterministically from vetting signals — never fabricated by the LLM.",
      "• Protected attributes (name, photo, gender, age, nationality, location) are NEVER used as scoring features.",
      "• 'Unknown' means no evidence was found — it is never inferred.",
      "• All evidence links point to the original public source content.",
      "• Candidate consent was recorded before vetting ran.",
    ];
    for (const pt of points) {
      const ptOverflow = ensureSpace(doc, y, 14, regular);
      if (ptOverflow) { page = ptOverflow.page; y = ptOverflow.y; drawPageFooter(page, regular, doc.getPageCount()); }
      drawText(page, pt, MARGIN, y, regular, 8, COLOR.navy);
      y -= 13;
    }
  }

  return doc.save();
}

// ── Browser download helper ────────────────────────────────────────────────────

export function downloadPdf(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
