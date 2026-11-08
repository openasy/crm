// A quote as PDF, made on the server with PDFKit. The text is set in DejaVu Sans, embedded in the file, because the
// PDF's built-in fonts have no ğ, ı, İ or ş: with an embedded font every Turkish letter is drawn and can be copied
// and searched. Prices are without KDV on each line; the subtotal, the KDV and the total with KDV are shown separately.
import { createRequire } from "node:module";
import PDFDocument from "pdfkit";

const require = createRequire(import.meta.url);
const FONT = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf");
const BOLD = require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf");

export type QuoteLanguage = "en" | "tr" | "de";

export interface QuoteDocument {
  number: string;
  /** YYYY-MM-DD */
  date: string;
  validUntil: string;
  currency: string;
  /** KDV, 0 to 100. */
  vat: number;
  language: QuoteLanguage;
  seller: { name: string; address: string | null; taxOffice: string | null; taxNumber: string | null; email: string | null; phone: string | null };
  buyer: { company: string | null; contact: string | null; email: string | null };
  deal: string;
  lines: Array<{ item: string; quantity: number; unitMinor: number; discount: number; totalMinor: number }>;
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
  notes: string | null;
  terms: string | null;
  /** Who prepared it. */
  by: string;
}

const WORDS: Record<QuoteLanguage, Record<string, string>> = {
  en: {
    quote: "Quote",
    number: "Number",
    date: "Date",
    valid: "Valid until",
    to: "To",
    for: "For",
    item: "Item",
    qty: "Qty",
    unit: "Unit price",
    discount: "Discount",
    total: "Total",
    subtotal: "Subtotal, without KDV",
    vat: "KDV {rate}%",
    grand: "Total with KDV",
    notes: "Notes",
    taxOffice: "Tax office",
    taxNumber: "Tax number",
    prepared: "Prepared by {name}",
    page: "Page {n} of {of}",
    pricesWithout: "Prices are without KDV.",
  },
  tr: {
    quote: "Teklif",
    number: "Teklif no",
    date: "Tarih",
    valid: "Geçerlilik",
    to: "Sayın",
    for: "Konu",
    item: "Ürün / hizmet",
    qty: "Miktar",
    unit: "Birim fiyat",
    discount: "İndirim",
    total: "Tutar",
    subtotal: "Ara toplam, KDV hariç",
    vat: "KDV %{rate}",
    grand: "Genel toplam, KDV dahil",
    notes: "Notlar",
    taxOffice: "Vergi dairesi",
    taxNumber: "Vergi no",
    prepared: "Hazırlayan: {name}",
    page: "Sayfa {n} / {of}",
    pricesWithout: "Fiyatlara KDV dahil değildir.",
  },
  de: {
    quote: "Angebot",
    number: "Nummer",
    date: "Datum",
    valid: "Gültig bis",
    to: "An",
    for: "Betreff",
    item: "Position",
    qty: "Menge",
    unit: "Einzelpreis",
    discount: "Rabatt",
    total: "Betrag",
    subtotal: "Zwischensumme, ohne KDV",
    vat: "KDV {rate} %",
    grand: "Gesamt mit KDV",
    notes: "Hinweise",
    taxOffice: "Finanzamt",
    taxNumber: "Steuernummer",
    prepared: "Erstellt von {name}",
    page: "Seite {n} von {of}",
    pricesWithout: "Preise ohne KDV.",
  },
};

const LOCALE: Record<QuoteLanguage, string> = { en: "en-GB", tr: "tr-TR", de: "de-DE" };

/** 4500000 kuruş is 45.000,00 TL in Turkish and 45,000.00 TL in English. TRY is written TL, as people write it. */
export function formatMoney(minor: number, currency: string, language: QuoteLanguage | string): string {
  const locale = LOCALE[language as QuoteLanguage] ?? "en-GB";
  const n = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100);
  return `${n} ${currency === "TRY" ? "TL" : currency}`;
}

const formatNumber = (n: number, language: QuoteLanguage) => new Intl.NumberFormat(LOCALE[language], { maximumFractionDigits: 3 }).format(n);

function formatDate(day: string, language: QuoteLanguage) {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat(LOCALE[language], { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(Date.UTC(y!, m! - 1, d!));
}

export function quotePdf(q: QuoteDocument): Promise<Buffer> {
  const w = (key: string, vars: Record<string, string | number> = {}) =>
    WORDS[q.language][key]!.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ""));
  const money = (minor: number) => formatMoney(minor, q.currency, q.language);
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 50, bottom: 60, left: 50, right: 50 },
    bufferPages: true,
    lang: q.language,
    info: { Title: `${w("quote")} ${q.number}`, Author: q.seller.name, Subject: q.deal, Creator: "OpenAsy CRM" },
  });
  doc.registerFont("text", FONT);
  doc.registerFont("bold", BOLD);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const muted = "#555555";

  // The seller, then the quote's number and dates on the right.
  doc
    .font("bold")
    .fontSize(14)
    .fillColor("#000000")
    .text(q.seller.name, left, 50, { width: width * 0.6 });
  doc.font("text").fontSize(8.5).fillColor(muted);
  const sellerLines = [
    q.seller.address,
    [q.seller.taxOffice && `${w("taxOffice")}: ${q.seller.taxOffice}`, q.seller.taxNumber && `${w("taxNumber")}: ${q.seller.taxNumber}`]
      .filter(Boolean)
      .join(" · ") || null,
    [q.seller.email, q.seller.phone].filter(Boolean).join(" · ") || null,
  ].filter((l): l is string => !!l);
  for (const l of sellerLines) doc.text(l, { width: width * 0.6 });
  const sellerBottom = doc.y;

  doc
    .font("bold")
    .fontSize(20)
    .fillColor("#000000")
    .text(w("quote"), left + width * 0.6, 50, { width: width * 0.4, align: "right" });
  doc.font("text").fontSize(9).fillColor(muted);
  for (const [k, v] of [
    [w("number"), q.number],
    [w("date"), formatDate(q.date, q.language)],
    [w("valid"), formatDate(q.validUntil, q.language)],
  ] as const)
    doc.text(`${k}: ${v}`, left + width * 0.6, doc.y, { width: width * 0.4, align: "right" });

  let y = Math.max(sellerBottom, doc.y) + 24;
  doc
    .moveTo(left, y)
    .lineTo(left + width, y)
    .lineWidth(0.5)
    .strokeColor("#cccccc")
    .stroke();
  y += 12;
  doc.font("text").fontSize(8.5).fillColor(muted).text(w("to"), left, y);
  doc
    .font("bold")
    .fontSize(11)
    .fillColor("#000000")
    .text(q.buyer.company ?? q.buyer.contact ?? "", left, doc.y);
  doc.font("text").fontSize(9.5);
  if (q.buyer.company && q.buyer.contact) doc.text(q.buyer.contact);
  if (q.buyer.email) doc.fillColor(muted).text(q.buyer.email).fillColor("#000000");
  doc.moveDown(0.6);
  doc.font("text").fontSize(8.5).fillColor(muted).text(w("for"));
  doc.font("text").fontSize(10).fillColor("#000000").text(q.deal, { width });
  doc.moveDown(1);

  // The lines. Item takes what the numbers leave.
  const anyDiscount = q.lines.some((l) => l.discount > 0);
  const cols = anyDiscount
    ? [
        { key: "item", w: 0.43, align: "left" as const },
        { key: "qty", w: 0.1, align: "right" as const },
        { key: "unit", w: 0.17, align: "right" as const },
        { key: "discount", w: 0.1, align: "right" as const },
        { key: "total", w: 0.2, align: "right" as const },
      ]
    : [
        { key: "item", w: 0.5, align: "left" as const },
        { key: "qty", w: 0.1, align: "right" as const },
        { key: "unit", w: 0.2, align: "right" as const },
        { key: "total", w: 0.2, align: "right" as const },
      ];
  const pad = 4;
  const row = (cells: string[], bold: boolean, shade: boolean) => {
    doc.font(bold ? "bold" : "text").fontSize(9);
    const heights = cells.map((c, i) => doc.heightOfString(c, { width: cols[i]!.w * width - 2 * pad }));
    const h = Math.max(...heights) + 2 * pad;
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const top = doc.y;
    if (shade) doc.rect(left, top, width, h).fill("#f2f2f2");
    let x = left;
    cells.forEach((c, i) => {
      doc.fillColor("#000000").text(c, x + pad, top + pad, { width: cols[i]!.w * width - 2 * pad, align: cols[i]!.align });
      x += cols[i]!.w * width;
    });
    doc.y = top + h;
    doc
      .moveTo(left, doc.y)
      .lineTo(left + width, doc.y)
      .lineWidth(0.3)
      .strokeColor("#dddddd")
      .stroke();
  };
  row(
    cols.map((c) => w(c.key)),
    true,
    true,
  );
  for (const l of q.lines) {
    const cells = [l.item, formatNumber(l.quantity, q.language), money(l.unitMinor)];
    // Turkish writes the percent sign first: %10.
    if (anyDiscount)
      cells.push(l.discount ? (q.language === "tr" ? `%${formatNumber(l.discount, q.language)}` : `${formatNumber(l.discount, q.language)}%`) : "");
    cells.push(money(l.totalMinor));
    row(cells, false, false);
  }

  // The totals, KDV on its own line.
  doc.moveDown(0.8);
  const totals: Array<[string, string, boolean]> = [
    [w("subtotal"), money(q.subtotalMinor), false],
    [w("vat", { rate: formatNumber(q.vat, q.language) }), money(q.vatMinor), false],
    [w("grand"), money(q.totalMinor), true],
  ];
  for (const [label, value, strong] of totals) {
    if (doc.y + 18 > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const top = doc.y;
    doc
      .font(strong ? "bold" : "text")
      .fontSize(strong ? 11 : 9.5)
      .fillColor("#000000");
    doc.text(label, left + width * 0.4, top, { width: width * 0.35, align: "right" });
    doc.text(value, left + width * 0.75, top, { width: width * 0.25, align: "right" });
    doc.y = Math.max(doc.y, top + (strong ? 16 : 14));
  }

  doc.moveDown(1.2);
  doc.font("text").fontSize(8.5).fillColor(muted).text(w("pricesWithout"), left, doc.y, { width });
  if (q.notes) {
    doc.moveDown(0.8);
    doc.font("bold").fontSize(9).fillColor("#000000").text(w("notes"), { width });
    doc.font("text").fontSize(9).text(q.notes, { width });
  }
  if (q.terms) {
    doc.moveDown(0.8);
    doc.font("text").fontSize(8.5).fillColor(muted).text(q.terms, { width });
  }
  doc.moveDown(0.8);
  doc
    .font("text")
    .fontSize(8.5)
    .fillColor(muted)
    .text(w("prepared", { name: q.by }), { width });

  // Page numbers, once every page exists.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font("text")
      .fontSize(7.5)
      .fillColor(muted)
      .text(`${q.seller.name} · ${q.number} · ${w("page", { n: i + 1, of: range.count })}`, left, doc.page.height - 35, {
        width,
        align: "center",
        lineBreak: false,
      });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}
