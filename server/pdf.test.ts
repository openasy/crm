// The quote PDF read back with pdf.js, as a PDF reader would: every Turkish letter is there as text, and KDV is shown
// on its own line between the subtotal and the total.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { formatMoney, quotePdf, type QuoteDocument } from "./pdf.ts";

async function textOf(pdf: Buffer): Promise<string[]> {
  const doc = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((x) => ("str" in x ? x.str : "")).join(" "));
  }
  return pages;
}

const QUOTE: QuoteDocument = {
  number: "Q-2026-118",
  date: "2026-11-07",
  validUntil: "2026-12-07",
  currency: "TRY",
  vat: 20,
  language: "tr",
  seller: {
    name: "Acme Yazılım A.Ş.",
    address: "Büyükdere Cad. 1, Şişli, İstanbul",
    taxOffice: "Zincirlikuyu",
    taxNumber: "1234567890",
    email: "satis@acme.example",
    phone: null,
  },
  buyer: { company: "Avcı Lojistik", contact: "Gizem Avcı", email: "gizem@avci.example" },
  deal: "Yenileme ve 20 ek kullanıcı, Mersin deposu",
  lines: [
    { item: "İş paketi, 48 kullanıcı, 12 ay", quantity: 48, unitMinor: 375000, discount: 0, totalMinor: 18000000 },
    { item: "Kurulum ve eğitim: Çağrı merkezi, Iğdır şubesi", quantity: 1, unitMinor: 1200000, discount: 0, totalMinor: 1200000 },
  ],
  subtotalMinor: 19200000,
  vatMinor: 3840000,
  totalMinor: 23040000,
  notes: "Öğle arası teslimat; ödeme şartları ekte. ÜRETİM, ĞÜŞÇÖ.",
  terms: "Ödeme fatura tarihinden itibaren 30 gün içinde yapılır.",
  by: "Hakan Yıldız",
};

describe("quote PDF", () => {
  it("draws every Turkish letter as text", async () => {
    const pdf = await quotePdf(QUOTE);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const text = (await textOf(pdf)).join(" ");
    for (const s of [
      "Teklif",
      "Acme Yazılım A.Ş.",
      "Şişli, İstanbul",
      "Avcı Lojistik",
      "Gizem Avcı",
      "İş paketi, 48 kullanıcı, 12 ay",
      "Çağrı merkezi, Iğdır şubesi",
      "Öğle arası",
      "Hazırlayan: Hakan Yıldız",
    ])
      expect(text).toContain(s);
    for (const letter of "çğıİöşüÇĞÖŞÜ") expect(text).toContain(letter);
  });

  it("shows prices without KDV, then the subtotal, KDV and total on lines of their own", async () => {
    const text = (await textOf(await quotePdf(QUOTE))).join(" ");
    const sub = text.indexOf("Ara toplam, KDV hariç");
    const vat = text.indexOf("KDV %20");
    const total = text.indexOf("Genel toplam, KDV dahil");
    expect(sub).toBeGreaterThan(0);
    expect(vat).toBeGreaterThan(sub);
    expect(total).toBeGreaterThan(vat);
    expect(text).toContain("192.000,00 TL");
    expect(text).toContain("38.400,00 TL");
    expect(text).toContain("230.400,00 TL");
    expect(text).toContain("3.750,00 TL");
    expect(text).toContain("Fiyatlara KDV dahil değildir.");
  });

  it("is written in English or German when the file says so, and runs onto more pages", async () => {
    const many = {
      ...QUOTE,
      language: "en" as const,
      lines: Array.from({ length: 60 }, (_x, i) => ({ item: `Line ${i + 1}`, quantity: 1, unitMinor: 100, discount: 10, totalMinor: 90 })),
    };
    const pages = await textOf(await quotePdf(many));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join(" ")).toContain("Subtotal, without KDV");
    expect(pages.at(-1)).toContain(`Page ${pages.length} of ${pages.length}`);
    expect((await textOf(await quotePdf({ ...QUOTE, language: "de" }))).join(" ")).toContain("Gesamt mit KDV");
  });

  it("writes amounts as each language does, TRY as TL", () => {
    expect(formatMoney(4500050, "TRY", "tr")).toBe("45.000,50 TL");
    expect(formatMoney(4500050, "TRY", "en")).toBe("45,000.50 TL");
    expect(formatMoney(100, "EUR", "de")).toBe("1,00 EUR");
  });
});
