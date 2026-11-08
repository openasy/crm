// CSV as spreadsheets write it (RFC 4180): quoted fields, quotes doubled inside them, line breaks in quotes, CRLF or LF.
// The separator is a comma, or a semicolon as Excel writes it in Turkish and German, chosen by the header line.

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const sep =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0)
      ? ";"
      : (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0)
        ? "\t"
        : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** 45000, 45.000,00, 45,000.50 and "45 000 TL": an amount in minor units, or null when it is not one. */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/\s|TL|TRY|₺|EUR|€|USD|\$/gi, "");
  if (!s) return null;
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? "." : ",";
    s = s.replace(dec === "." ? /,/g : /\./g, "").replace(dec, ".");
  } else if (lastComma >= 0) {
    // 45,5 or 45,50 is a decimal comma; 45,000 is thousands.
    s = /,\d{1,2}$/.test(s) && s.split(",").length === 2 ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (lastDot >= 0 && /\.\d{3}$/.test(s) && s.split(".").length > 2) s = s.replace(/\./g, "");
  else if (lastDot >= 0 && /^\d{1,3}\.\d{3}$/.test(s)) s = s.replace(".", "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const minor = Math.round(Number(s) * 100);
  return neg ? -minor : minor;
}

/** 2026-11-28, 28.11.2026 or 28/11/2026: YYYY-MM-DD, or null. */
export function parseDay(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s))) [y, mo, d] = [Number(m[3]), Number(m[2]), Number(m[1])];
  else return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}
