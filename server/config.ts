// CRM's settings, from one YAML file (CRM_CONFIG): the pipelines and their stages with the probability and the days
// without activity each allows, the reasons deals are lost, the plans companies are on, where leads start, quotes and
// their KDV, task reminders, the mail server, the calendars and meeting links, and the links to Audience and Messages.
// As in the other products, the file is the only way in: no screen or API route changes these. It is applied whole or
// not at all, read again within a minute of a change, and a file with a mistake leaves the last good version in place.
// Companies, contacts, deals and everything done on them are kept in the database.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import { describeHours, parseHours, validTimeZone, type Hours } from "./hours.ts";

export interface Stage {
  id: string;
  name: string;
  /** 0 to 100: the share of the deal's value the forecast counts while it is in this stage. */
  probability: number;
  /** Days without activity after which an open deal in this stage is stale; null for never. */
  staleDays: number | null;
}

export interface Pipeline {
  id: string;
  name: string;
  stages: Stage[];
  lostReasons: string[];
  wonReasons: string[];
}

export interface Plan {
  /** What Helpdesk's routing rules and sla_by_plan match, such as business. */
  id: string;
  name: string;
}

export interface MeetingLink {
  /** In the booking page's address: /book/<id>. */
  id: string;
  name: string;
  /** The member whose calendar is read and written, by email. */
  owner: string;
  minutes: number;
  hours: Hours;
  /** Minutes kept free before and after each meeting. */
  bufferMinutes: number;
  /** The earliest a meeting can be booked, in minutes from now. */
  noticeMinutes: number;
  daysAhead: number;
  /** Where the deal a booking opens starts. */
  pipeline: string;
  stage: string;
  /** Ask for an online meeting (Meet or Teams) in the invitation. */
  online: boolean;
}

export interface Calendars {
  google: { clientId: string; clientSecret: string } | null;
  microsoft: { clientId: string; clientSecret: string; tenant: string } | null;
}

export interface Config {
  /** ISO 4217 code values and quotes are in, such as TRY. */
  currency: string;
  timeZone: string;
  pipelines: Pipeline[];
  plans: Plan[];
  leads: { pipeline: string; stage: string; owner: string | null };
  quotes: {
    /** KDV, 0 to 100, added to every quote created while it is set. */
    vat: number;
    validDays: number;
    /** The language the PDF is written in. */
    language: "en" | "tr" | "de";
    seller: { name: string; address: string | null; taxOffice: string | null; taxNumber: string | null; email: string | null; phone: string | null };
    terms: string | null;
  };
  tasks: { remindAt: number };
  mail: { host: string; port: number; security: "starttls" | "tls" | "none"; user: string | null; password: string; from: string } | null;
  calendars: Calendars;
  meetingLinks: MeetingLink[];
  audience: { url: string; token: string; events: boolean; profile: boolean } | null;
  messages: { url: string; token: string; sequences: Array<{ id: string; name: string; event: string }> } | null;
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const EVENT = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const TOP = ["currency", "time_zone", "pipelines", "plans", "leads", "quotes", "tasks", "mail", "calendars", "meeting_links", "audience", "messages"];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function keys(v: Record<string, unknown>, at: string, allowed: string[]) {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; it takes ${allowed.join(", ")}.`);
}

function text(v: unknown, at: string, max = 80): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${at} is a text of 1 to ${max} characters.`);
  return v.trim();
}

const optText = (v: unknown, at: string, max = 200): string | null => (v === undefined || v === null ? null : text(String(v), at, max));

function env(v: unknown, at: string): string {
  if (typeof v !== "string" || !ENV.test(v))
    throw new Error(`${at} is the name of an environment variable, such as CRM_AUDIENCE_TOKEN, never the secret itself.`);
  return v;
}

function share(v: unknown, at: string): number {
  const m = typeof v === "number" ? [String(v), String(v)] : /^(\d+(?:\.\d+)?)\s*%$/.exec(String(v ?? "").trim());
  const n = m ? Number(m[1]) : NaN;
  if (!(n >= 0 && n <= 100)) throw new Error(`${at} is a share from 0% to 100%, such as 25%.`);
  return n;
}

/** 30m, 2h, 14d: a duration in minutes. */
export function minutesOf(v: unknown, at: string, units = "mhd"): number {
  const m = /^(\d{1,5})\s*([mhd])$/.exec(String(v ?? "").trim());
  if (!m || !units.includes(m[2]!)) {
    const examples = { m: "30m", h: "4h", d: "14d" } as Record<string, string>;
    throw new Error(`${at} is a duration such as ${[...units].map((u) => examples[u]).join(" or ")}.`);
  }
  return Number(m[1]) * { m: 1, h: 60, d: 1440 }[m[2] as "m" | "h" | "d"];
}

/** An address of another product: https://, or http:// inside the install (localhost, or a host without dots). */
function baseUrl(raw: unknown, at: string): string {
  const url = typeof raw === "string" ? URL.parse(raw.trim()) : null;
  const inside = url && (/^(localhost|127\.0\.0\.1)$/.test(url.hostname) || !url.hostname.includes("."));
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && inside)) || url.search || url.hash)
    throw new Error(`${at} is an https:// address, such as https://audience.example.com (http:// only for a host without dots, such as http://audience:8080).`);
  return url.origin + url.pathname.replace(/\/$/, "");
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
function email(v: unknown, at: string): string {
  if (typeof v !== "string" || !EMAIL.test(v.trim()) || v.length > 254) throw new Error(`${at} is an email address.`);
  return v.trim().toLowerCase();
}

function reasons(v: unknown, at: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 30) throw new Error(`${at} is a list of up to 30 reasons.`);
  return [...new Set(v.map((r, i) => text(r, `${at}[${i}]`)))];
}

/** Reads `sales/demo` or `demo` (in the default pipeline) into a pipeline and a stage that exist. */
function stageRef(v: unknown, at: string, pipelines: Pipeline[], defaultPipeline: string): { pipeline: string; stage: string } {
  const raw = text(v, at, 70);
  const [p, s] = raw.includes("/") ? raw.split("/", 2) : [defaultPipeline, raw];
  const pipeline = pipelines.find((x) => x.id === p);
  if (!pipeline) throw new Error(`${at}: ${p} is not a pipeline in the file.`);
  if (!pipeline.stages.some((x) => x.id === s))
    throw new Error(`${at}: ${s} is not a stage of ${pipeline.id}; it has ${pipeline.stages.map((x) => x.id).join(", ")}.`);
  return { pipeline: pipeline.id, stage: s! };
}

const DEFAULT_PIPELINE: Pipeline = {
  id: "sales",
  name: "Sales",
  stages: [
    { id: "lead", name: "Lead", probability: 10, staleDays: 14 },
    { id: "qualified", name: "Qualified", probability: 25, staleDays: 10 },
    { id: "proposal", name: "Proposal", probability: 50, staleDays: 10 },
    { id: "negotiation", name: "Negotiation", probability: 75, staleDays: 7 },
  ],
  lostReasons: ["Price", "Timing", "Chose another product", "No answer"],
  wonReasons: [],
};

/** Reads the file's text. Throws with the field at fault, so one message says what to fix. */
export function parseConfig(raw: string): Config {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (!isObj(doc)) throw new Error(`The file is a map of ${TOP.join(", ")}.`);
  keys(doc, "The file", TOP);

  const currency = doc.currency === undefined ? "TRY" : String(doc.currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("currency is a three-letter ISO 4217 code, such as TRY or EUR.");
  const timeZone = doc.time_zone === undefined ? "Europe/Istanbul" : text(doc.time_zone, "time_zone", 64);
  if (!validTimeZone(timeZone)) throw new Error(`time_zone: ${timeZone} is not a time zone, such as Europe/Istanbul.`);

  // Pipelines and their stages.
  const pipelines: Pipeline[] = [];
  const ps = doc.pipelines ?? null;
  if (ps === null) pipelines.push(DEFAULT_PIPELINE);
  else {
    if (!isObj(ps) || Object.keys(ps).length < 1 || Object.keys(ps).length > 20)
      throw new Error("pipelines is a map of 1 to 20 pipelines, such as sales: { stages: [...] }.");
    for (const [id, v] of Object.entries(ps)) {
      const at = `pipelines.${id}`;
      if (!ID.test(id)) throw new Error(`${at}: a pipeline id is up to 32 lowercase letters, digits and -.`);
      if (!isObj(v)) throw new Error(`${at} is a map with name, stages, lost_reasons and won_reasons.`);
      keys(v, at, ["name", "stages", "lost_reasons", "won_reasons"]);
      if (!Array.isArray(v.stages) || v.stages.length < 1 || v.stages.length > 15) throw new Error(`${at}.stages is a list of 1 to 15 stages.`);
      const stages: Stage[] = v.stages.map((s, i) => {
        const sat = `${at}.stages[${i}]`;
        if (!isObj(s)) throw new Error(`${sat} is { id, name, probability, stale_after }.`);
        keys(s, sat, ["id", "name", "probability", "stale_after"]);
        if (typeof s.id !== "string" || !ID.test(s.id) || s.id === "won" || s.id === "lost")
          throw new Error(`${sat}.id is up to 32 lowercase letters, digits and -, other than won and lost.`);
        const stale =
          s.stale_after === undefined || s.stale_after === null || s.stale_after === "never"
            ? null
            : minutesOf(s.stale_after, `${sat}.stale_after`, "d") / 1440;
        if (stale !== null && (stale < 1 || stale > 365)) throw new Error(`${sat}.stale_after is 1d to 365d, or never.`);
        return {
          id: s.id,
          name: s.name === undefined ? s.id : text(s.name, `${sat}.name`, 40),
          probability: share(s.probability, `${sat}.probability`),
          staleDays: stale,
        };
      });
      const dup = stages.find((s, i) => stages.findIndex((x) => x.id === s.id) !== i);
      if (dup) throw new Error(`${at}.stages: ${dup.id} is in the list twice.`);
      pipelines.push({
        id,
        name: v.name === undefined ? id.charAt(0).toUpperCase() + id.slice(1) : text(v.name, `${at}.name`, 40),
        stages,
        lostReasons: reasons(v.lost_reasons, `${at}.lost_reasons`),
        wonReasons: reasons(v.won_reasons, `${at}.won_reasons`),
      });
    }
  }
  const first = pipelines[0]!;

  // Plans: what a company is on. Helpdesk routes and sets SLAs by the plan's id.
  const plans: Plan[] = [];
  const pl = doc.plans ?? {};
  if (!isObj(pl) || Object.keys(pl).length > 50) throw new Error("plans is a map of up to 50 plan ids to names, such as business: Business.");
  for (const [id, v] of Object.entries(pl)) {
    if (!ID.test(id)) throw new Error(`plans.${id}: a plan id is up to 32 lowercase letters, digits and -.`);
    if (isObj(v)) keys(v, `plans.${id}`, ["name"]);
    const name =
      v === null || v === undefined ? id : isObj(v) ? (v.name === undefined ? id : text(v.name, `plans.${id}.name`, 40)) : text(String(v), `plans.${id}`, 40);
    plans.push({ id, name });
  }

  // Where leads from Live Chat, forms and the API start.
  const ld = doc.leads ?? {};
  if (!isObj(ld)) throw new Error("leads is a map with stage and owner.");
  keys(ld, "leads", ["stage", "owner"]);
  const leadAt = ld.stage === undefined ? { pipeline: first.id, stage: first.stages[0]!.id } : stageRef(ld.stage, "leads.stage", pipelines, first.id);
  const leads = { ...leadAt, owner: ld.owner === undefined || ld.owner === null ? null : email(ld.owner, "leads.owner") };

  // Quotes.
  const qt = doc.quotes ?? {};
  if (!isObj(qt)) throw new Error("quotes is a map with vat, valid_for, language, seller and terms.");
  keys(qt, "quotes", ["vat", "valid_for", "language", "seller", "terms"]);
  const language = qt.language ?? "tr";
  if (language !== "en" && language !== "tr" && language !== "de") throw new Error("quotes.language is en, tr or de: the language of the PDF.");
  const sl = qt.seller ?? {};
  if (!isObj(sl)) throw new Error("quotes.seller is a map with name, address, tax_office, tax_number, email and phone.");
  keys(sl, "quotes.seller", ["name", "address", "tax_office", "tax_number", "email", "phone"]);
  const validDays = qt.valid_for === undefined ? 30 : minutesOf(qt.valid_for, "quotes.valid_for", "d") / 1440;
  if (validDays < 1 || validDays > 365) throw new Error("quotes.valid_for is 1d to 365d.");
  const quotes = {
    vat: qt.vat === undefined ? 20 : share(qt.vat, "quotes.vat"),
    validDays,
    language: language as "en" | "tr" | "de",
    seller: {
      name: sl.name === undefined ? "Our company" : text(sl.name, "quotes.seller.name", 120),
      address: optText(sl.address, "quotes.seller.address", 300),
      taxOffice: optText(sl.tax_office, "quotes.seller.tax_office", 80),
      taxNumber: optText(sl.tax_number, "quotes.seller.tax_number", 20),
      email: sl.email === undefined || sl.email === null ? null : email(sl.email, "quotes.seller.email"),
      phone: optText(sl.phone, "quotes.seller.phone", 40),
    },
    terms: optText(qt.terms, "quotes.terms", 1000),
  };

  // Task reminders: the morning a task is due, in time_zone.
  const tk = doc.tasks ?? {};
  if (!isObj(tk)) throw new Error("tasks is a map with remind_at.");
  keys(tk, "tasks", ["remind_at"]);
  const rm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(tk.remind_at ?? "08:00"));
  if (!rm) throw new Error("tasks.remind_at is a time such as 08:00.");
  const tasks = { remindAt: Number(rm[1]) * 60 + Number(rm[2]) };

  // The mail server reminders and quotes are sent through.
  let mail: Config["mail"] = null;
  if (doc.mail !== undefined && doc.mail !== null) {
    const m = doc.mail;
    if (!isObj(m)) throw new Error("mail is a map with host, port, security, user, password and from.");
    keys(m, "mail", ["host", "port", "security", "user", "password", "from"]);
    const security = m.security ?? "starttls";
    if (security !== "starttls" && security !== "tls" && security !== "none") throw new Error("mail.security is starttls, tls or none.");
    const host = text(m.host, "mail.host", 253);
    if (security === "none" && !/^(localhost|127\.0\.0\.1)$/.test(host) && host.includes("."))
      throw new Error("mail.security none is only for a server on this machine or the install's network; use starttls or tls.");
    const port = m.port ?? (security === "tls" ? 465 : 587);
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new Error("mail.port is a port number.");
    mail = {
      host,
      port: port as number,
      security,
      user: optText(m.user, "mail.user", 254),
      password: m.password === undefined ? "CRM_MAIL_PASSWORD" : env(m.password, "mail.password"),
      from: text(m.from, "mail.from", 254),
    };
  }

  // Calendars people connect for their meeting links.
  const cl = doc.calendars ?? {};
  if (!isObj(cl)) throw new Error("calendars is a map with google and microsoft.");
  keys(cl, "calendars", ["google", "microsoft"]);
  const calendars: Calendars = { google: null, microsoft: null };
  if (cl.google !== undefined && cl.google !== null) {
    if (!isObj(cl.google)) throw new Error("calendars.google is a map with client_id and client_secret.");
    keys(cl.google, "calendars.google", ["client_id", "client_secret"]);
    calendars.google = {
      clientId: env(cl.google.client_id ?? "CRM_GOOGLE_CLIENT_ID", "calendars.google.client_id"),
      clientSecret: env(cl.google.client_secret ?? "CRM_GOOGLE_CLIENT_SECRET", "calendars.google.client_secret"),
    };
  }
  if (cl.microsoft !== undefined && cl.microsoft !== null) {
    if (!isObj(cl.microsoft)) throw new Error("calendars.microsoft is a map with client_id, client_secret and tenant.");
    keys(cl.microsoft, "calendars.microsoft", ["client_id", "client_secret", "tenant"]);
    const tenant = cl.microsoft.tenant ?? "common";
    if (typeof tenant !== "string" || !/^[A-Za-z0-9.-]{1,64}$/.test(tenant))
      throw new Error("calendars.microsoft.tenant is common, organizations or your tenant id.");
    calendars.microsoft = {
      clientId: env(cl.microsoft.client_id ?? "CRM_MICROSOFT_CLIENT_ID", "calendars.microsoft.client_id"),
      clientSecret: env(cl.microsoft.client_secret ?? "CRM_MICROSOFT_CLIENT_SECRET", "calendars.microsoft.client_secret"),
      tenant,
    };
  }

  // Meeting links.
  const meetingLinks: MeetingLink[] = [];
  const ml = doc.meeting_links ?? {};
  if (!isObj(ml) || Object.keys(ml).length > 50) throw new Error("meeting_links is a map of up to 50 links, such as demo: { owner, length, hours }.");
  for (const [id, v] of Object.entries(ml)) {
    const at = `meeting_links.${id}`;
    if (!ID.test(id)) throw new Error(`${at}: a link id is up to 32 lowercase letters, digits and -.`);
    if (!isObj(v)) throw new Error(`${at} is a map with name, owner, length, hours, buffer, notice, days_ahead, creates_deal_in and online.`);
    keys(v, at, ["name", "owner", "length", "hours", "buffer", "notice", "days_ahead", "creates_deal_in", "online"]);
    const minutes = v.length === undefined ? 30 : minutesOf(v.length, `${at}.length`, "mh");
    if (minutes < 10 || minutes > 480) throw new Error(`${at}.length is 10m to 8h.`);
    const days = parseHours(String(v.hours ?? "weekdays 09:00-18:00"), `${at}.hours`);
    if (!days) throw new Error(`${at}.hours are days and times, such as weekdays 09:00-18:00; a meeting link is never always open.`);
    const daysAhead = v.days_ahead ?? 14;
    if (!Number.isInteger(daysAhead) || (daysAhead as number) < 1 || (daysAhead as number) > 60) throw new Error(`${at}.days_ahead is 1 to 60.`);
    if (v.online !== undefined && typeof v.online !== "boolean") throw new Error(`${at}.online is true or false.`);
    const where =
      v.creates_deal_in === undefined
        ? { pipeline: leadAt.pipeline, stage: leadAt.stage }
        : stageRef(v.creates_deal_in, `${at}.creates_deal_in`, pipelines, first.id);
    meetingLinks.push({
      id,
      name: v.name === undefined ? `${minutes} minute meeting` : text(v.name, `${at}.name`, 80),
      owner: email(v.owner, `${at}.owner`),
      minutes,
      hours: { always: false, days, timeZone, holidays: [] },
      bufferMinutes: v.buffer === undefined ? 0 : minutesOf(v.buffer, `${at}.buffer`, "mh"),
      noticeMinutes: v.notice === undefined ? 240 : minutesOf(v.notice, `${at}.notice`),
      daysAhead: daysAhead as number,
      ...where,
      online: v.online !== false,
    });
  }

  // Audience: contacts and deal events go there, and the deal shows the lead's profile.
  let audience: Config["audience"] = null;
  if (doc.audience !== undefined && doc.audience !== null) {
    const a = doc.audience;
    if (!isObj(a)) throw new Error("audience is a map with url, token, events and profile.");
    keys(a, "audience", ["url", "token", "events", "profile"]);
    for (const k of ["events", "profile"] as const) if (a[k] !== undefined && typeof a[k] !== "boolean") throw new Error(`audience.${k} is true or false.`);
    audience = {
      url: baseUrl(a.url, "audience.url"),
      token: a.token === undefined ? "CRM_AUDIENCE_TOKEN" : env(a.token, "audience.token"),
      events: a.events !== false,
      profile: a.profile !== false,
    };
  }

  // Messages: sales sequences are journeys there, started by an event CRM posts.
  let messages: Config["messages"] = null;
  if (doc.messages !== undefined && doc.messages !== null) {
    const m = doc.messages;
    if (!isObj(m)) throw new Error("messages is a map with url, token and sequences.");
    keys(m, "messages", ["url", "token", "sequences"]);
    const sq = m.sequences ?? {};
    if (!isObj(sq) || Object.keys(sq).length > 50) throw new Error("messages.sequences is a map of up to 50 sequences, such as follow-up: { name, event }.");
    const sequences = Object.entries(sq).map(([id, v]) => {
      const at = `messages.sequences.${id}`;
      if (!ID.test(id)) throw new Error(`${at}: a sequence id is up to 32 lowercase letters, digits and -.`);
      if (!isObj(v)) throw new Error(`${at} is a map with name and event.`);
      keys(v, at, ["name", "event"]);
      if (typeof v.event !== "string" || !EVENT.test(v.event)) throw new Error(`${at}.event is the event a Messages journey starts on, such as crm_follow_up.`);
      return { id, name: v.name === undefined ? id : text(v.name, `${at}.name`), event: v.event };
    });
    messages = { url: baseUrl(m.url, "messages.url"), token: m.token === undefined ? "CRM_MESSAGES_TOKEN" : env(m.token, "messages.token"), sequences };
  }

  return { currency, timeZone, pipelines, plans, leads, quotes, tasks, mail, calendars, meetingLinks, audience, messages };
}

/** Things to fix that do not stop the file from being applied: secrets that are not set, owners who are not members. */
export function configWarnings(c: Config, environment: Record<string, string | undefined>, members: string[]): string[] {
  const w: string[] = [];
  const unset = (name: string) => !environment[name];
  if (c.mail && unset(c.mail.password) && c.mail.user) w.push(`mail: ${c.mail.password} is not set, so reminders and quotes cannot be sent.`);
  if (c.calendars.google && (unset(c.calendars.google.clientId) || unset(c.calendars.google.clientSecret)))
    w.push(`calendars.google: ${c.calendars.google.clientId} or ${c.calendars.google.clientSecret} is not set, so Google Calendar cannot be connected.`);
  if (c.calendars.microsoft && (unset(c.calendars.microsoft.clientId) || unset(c.calendars.microsoft.clientSecret)))
    w.push(
      `calendars.microsoft: ${c.calendars.microsoft.clientId} or ${c.calendars.microsoft.clientSecret} is not set, so Microsoft calendars cannot be connected.`,
    );
  if (c.meetingLinks.length && !c.calendars.google && !c.calendars.microsoft) w.push("meeting_links: no calendar under calendars, so no link offers a time.");
  for (const l of c.meetingLinks) if (!members.includes(l.owner)) w.push(`meeting_links.${l.id}.owner: ${l.owner} is not a member of CRM.`);
  if (c.leads.owner && !members.includes(c.leads.owner)) w.push(`leads.owner: ${c.leads.owner} is not a member of CRM.`);
  if (c.audience && unset(c.audience.token)) w.push(`audience: ${c.audience.token} is not set, so nothing is sent to Audience.`);
  if (c.messages && unset(c.messages.token)) w.push(`messages: ${c.messages.token} is not set, so no sequence can be started.`);
  return w;
}

/** The meeting link's hours as people read them, for the settings page and the API. */
export const linkHours = (l: MeetingLink) => describeHours(l.hours);

export interface ConfigFileState {
  path: string;
  /** When the file was last read and applied, or null if it never was. */
  appliedAt: string | null;
  /** Why the file on disk is not what is applied; the last good version stays until it is fixed. */
  error: string | null;
  /** Things to fix that did not stop the file from being applied. */
  warnings: string[];
}

/**
 * Reads the file now and whenever it changes (checked every `everyMs`, by size, time and content), and hands each new
 * version and its text to `apply`, which returns warnings or throws to refuse it. A file that cannot be read or applied
 * leaves the last good version in place. `stop()` ends the polling.
 */
export function watchConfig(
  path: string,
  apply: (config: Config, text: string) => string[],
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, error: null, warnings: [] };
  let seen = "";
  const read = () => {
    let raw: string;
    let stamp: string;
    try {
      const st = statSync(path);
      raw = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(raw).digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      state.warnings = apply(parseConfig(raw), raw);
      Object.assign(state, { appliedAt: new Date().toISOString(), error: null });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
