// The booking page people open from a meeting link: /book/<id>. It is plain HTML with a form, served by CRM, with no
// script, so it works wherever the link is opened. It shows the free times in the link's time zone, in English,
// Turkish or German by the browser's language (or ?lang=).
import type { IncomingMessage } from "node:http";
import type { Meetings } from "./meetings.ts";
import { CrmError } from "./store.ts";

type Lang = "en" | "tr" | "de";

const WORDS: Record<Lang, Record<string, string>> = {
  en: {
    with: "{minutes} minutes with {owner}",
    zone: "Times in {zone}",
    pick: "Pick a time",
    none: "No free time in the next days. Try again later.",
    name: "Name",
    email: "Email",
    company: "Company",
    note: "Anything we should know (optional)",
    book: "Book",
    booked: "Booked",
    bookedText: "{when} with {owner}. The invitation is on its way to {email}.",
    join: "Join the meeting",
    unavailable: "This link cannot be booked right now.",
    notFound: "There is no such meeting link.",
  },
  tr: {
    with: "{owner} ile {minutes} dakika",
    zone: "Saatler {zone} saatine göre",
    pick: "Bir saat seçin",
    none: "Önümüzdeki günlerde boş saat yok. Daha sonra yeniden deneyin.",
    name: "Ad soyad",
    email: "E-posta",
    company: "Şirket",
    note: "Bilmemizi istediğiniz bir şey (isteğe bağlı)",
    book: "Randevu al",
    booked: "Randevunuz alındı",
    bookedText: "{when}, {owner} ile. Davet {email} adresine gönderiliyor.",
    join: "Toplantıya katıl",
    unavailable: "Bu bağlantıdan şu anda randevu alınamıyor.",
    notFound: "Böyle bir toplantı bağlantısı yok.",
  },
  de: {
    with: "{minutes} Minuten mit {owner}",
    zone: "Zeiten in {zone}",
    pick: "Wählen Sie eine Zeit",
    none: "In den nächsten Tagen ist keine Zeit frei. Versuchen Sie es später noch einmal.",
    name: "Name",
    email: "E-Mail",
    company: "Firma",
    note: "Was wir wissen sollten (optional)",
    book: "Buchen",
    booked: "Gebucht",
    bookedText: "{when} mit {owner}. Die Einladung geht an {email}.",
    join: "Am Meeting teilnehmen",
    unavailable: "Über diesen Link kann gerade nicht gebucht werden.",
    notFound: "Diesen Meeting-Link gibt es nicht.",
  },
};
const LOCALE: Record<Lang, string> = { en: "en-GB", tr: "tr-TR", de: "de-DE" };

export function pickLang(req: IncomingMessage, url: URL): Lang {
  const asked = url.searchParams.get("lang");
  if (asked === "en" || asked === "tr" || asked === "de") return asked;
  for (const part of (req.headers["accept-language"] ?? "").split(",")) {
    const l = part.trim().slice(0, 2).toLowerCase();
    if (l === "en" || l === "tr" || l === "de") return l;
  }
  return "en";
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(lang: Lang, title: string, accent: string, inner: string) {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; --accent: ${accent}; --fg: #1a1a1a; --muted: #5c5c5c; --line: #d9d9d9; --bg: #ffffff; --canvas: #f6f6f5; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececec; --muted: #a3a3a3; --line: #3a3a3a; --bg: #1c1c1c; --canvas: #141414; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--canvas); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 32px 16px; }
.card { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 20px; }
h1 { font-size: 20px; margin: 0 0 4px; }
p.muted, .muted { color: var(--muted); font-size: 13px; margin: 0; }
fieldset { border: 0; padding: 0; margin: 16px 0 0; }
legend { font-weight: 600; margin-bottom: 8px; }
.day { margin: 12px 0 4px; font-size: 13px; font-weight: 600; }
.slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; }
.slots label { display: block; }
.slots input { position: absolute; opacity: 0; }
.slots span { display: block; text-align: center; border: 1px solid var(--line); border-radius: 6px; padding: 6px 4px; cursor: pointer; }
.slots input:checked + span { border-color: var(--accent); outline: 2px solid var(--accent); }
.slots input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
.field { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; font-size: 13px; }
.field input, .field textarea { font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
.hp { position: absolute; left: -10000px; }
button, a.button { display: inline-block; margin-top: 16px; background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 9px 16px; font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; }
.error { margin-top: 12px; padding: 8px 10px; border-radius: 6px; background: #fdecea; color: #8a1c13; font-size: 14px; }
@media (prefers-color-scheme: dark) { .error { background: #3b1512; color: #f6b8b1; } }
</style>
</head>
<body><main><div class="card">${inner}</div></main></body>
</html>`;
}

/** The booking form, or a page saying the link cannot be booked. */
export async function bookingPage(
  meetings: Meetings,
  id: string,
  lang: Lang,
  accent: string,
  error?: string,
  values: Record<string, string> = {},
): Promise<{ status: number; html: string }> {
  const w = WORDS[lang];
  const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => esc(String(v[k] ?? "")));
  let info;
  try {
    info = await meetings.publicSlots(id);
  } catch (err) {
    const missing = err instanceof CrmError && err.status === 404;
    return { status: missing ? 404 : 503, html: page(lang, w.unavailable!, accent, `<h1>${esc(missing ? w.notFound! : w.unavailable!)}</h1>`) };
  }
  const day = new Intl.DateTimeFormat(LOCALE[lang], { weekday: "long", day: "numeric", month: "long", timeZone: info.timeZone });
  const time = new Intl.DateTimeFormat(LOCALE[lang], { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: info.timeZone });
  const groups = new Map<string, string[]>();
  for (const s of info.slots) {
    const d = day.format(new Date(s.start));
    const checked = values.start === s.start ? " checked" : "";
    groups.set(d, [
      ...(groups.get(d) ?? []),
      `<label><input type="radio" name="start" value="${s.start}" required${checked}><span>${time.format(new Date(s.start))}</span></label>`,
    ]);
  }
  const slots = info.slots.length
    ? [...groups].map(([d, list]) => `<div class="day">${esc(d)}</div><div class="slots">${list.join("")}</div>`).join("")
    : `<p class="muted">${esc(w.none!)}</p>`;
  const v = (k: string) => esc(values[k] ?? "");
  const inner = `<h1>${esc(info.name)}</h1>
<p class="muted">${fill(w.with!, { minutes: info.minutes, owner: info.owner })} · ${fill(w.zone!, { zone: info.timeZone })}</p>
${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/book/${esc(id)}?lang=${lang}">
<fieldset><legend>${esc(w.pick!)}</legend>${slots}</fieldset>
${
  info.slots.length
    ? `<label class="field">${esc(w.name!)}<input name="name" autocomplete="name" required maxlength="120" value="${v("name")}"></label>
<label class="field">${esc(w.email!)}<input name="email" type="email" autocomplete="email" required maxlength="254" value="${v("email")}"></label>
<label class="field">${esc(w.company!)}<input name="company" autocomplete="organization" maxlength="120" value="${v("company")}"></label>
<label class="field">${esc(w.note!)}<textarea name="note" rows="3" maxlength="1000">${v("note")}</textarea></label>
<label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
<button type="submit">${esc(w.book!)}</button>`
    : ""
}
</form>`;
  return { status: 200, html: page(lang, info.name, accent, inner) };
}

export async function bookFromForm(
  meetings: Meetings,
  id: string,
  lang: Lang,
  accent: string,
  form: URLSearchParams,
): Promise<{ status: number; html: string }> {
  const w = WORDS[lang];
  const values = Object.fromEntries(["start", "name", "email", "company", "note", "website"].map((k) => [k, form.get(k) ?? ""]));
  try {
    const r = await meetings.book(id, {
      start: values.start,
      name: values.name,
      email: values.email,
      ...(values.company && { company: values.company }),
      ...(values.note && { note: values.note }),
      ...(values.website && { website: values.website }),
    });
    const when = new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: "full", timeStyle: "short", timeZone: r.booking.timeZone }).format(
      new Date(r.booking.start),
    );
    const text = w.bookedText!.replace(/\{(\w+)\}/g, (_m, k: string) => esc(String({ when, owner: r.booking.owner, email: values.email }[k] ?? "")));
    const join = r.booking.joinUrl ? `<a class="button" href="${esc(r.booking.joinUrl)}" rel="noreferrer">${esc(w.join!)}</a>` : "";
    return { status: 201, html: page(lang, w.booked!, accent, `<h1>${esc(w.booked!)}</h1><p>${text}</p>${join}`) };
  } catch (err) {
    if (!(err instanceof CrmError)) throw err;
    const again = await bookingPage(meetings, id, lang, accent, err.message, values);
    return { status: err.status === 404 ? 404 : err.status, html: again.html };
  }
}
