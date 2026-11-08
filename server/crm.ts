// CRM: companies, contacts and deals through the pipelines the settings file sets, with activities, tasks, quotes,
// the forecast and the reports, CSV import, and what other products call (Helpdesk's lookup, Live Chat's leads,
// Audience's erasures). Meeting links and calendars are in meetings.ts. The HTTP layer (app.ts) is outside; everything
// here works on the database and the applied settings.
//
// Ownership: every company, contact and deal has at most one owner, a member. Viewers see everything; editors change
// what they own, and what has no owner yet; admins change everything.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { atLeast } from "@openasy/auth";
import { configWarnings, type Config, type ConfigFileState, type Pipeline, type Stage } from "./config.ts";
import { parseAmount, parseCsv, parseDay } from "./csv.ts";
import { fromWallClock, localDate } from "./hours.ts";
import {
  audienceLink,
  LinkError,
  messagesLink,
  smtpMailer,
  type AudienceEvent,
  type AudienceLink,
  type Mailer,
  type MessagesEvent,
  type MessagesLink,
} from "./links.ts";
import { log } from "./log.ts";
import { formatMoney, quotePdf } from "./pdf.ts";
import {
  amount,
  bad,
  body,
  createStore,
  CrmError,
  DAY,
  isObj,
  MINUTE,
  money,
  notFound,
  optDay,
  optEmail,
  optText,
  phoneKey,
  text,
  type Actor,
} from "./store.ts";

export { CrmError, type Actor, type ProblemCode } from "./store.ts";

// ------------------------------------------------------------------ rows

interface CompanyRow {
  id: string;
  name: string;
  domain: string | null;
  sector: string | null;
  city: string | null;
  plan: string | null;
  plan_renews: string | null;
  users: number | null;
  owner_id: string | null;
  owner_name: string | null;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ContactRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  company_id: string | null;
  owner_id: string | null;
  owner_name: string | null;
  source: string;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

interface DealRow {
  id: string;
  name: string;
  pipeline: string;
  stage: string;
  status: "open" | "won" | "lost";
  value_minor: number;
  currency: string;
  company_id: string | null;
  contact_id: string | null;
  owner_id: string | null;
  owner_name: string | null;
  expected_close: string | null;
  source: string;
  source_detail: string | null;
  reason: string | null;
  reason_note: string | null;
  closed_at: string | null;
  stage_entered_at: string;
  last_activity_at: string;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ActivityRow {
  id: string;
  kind: "call" | "meeting" | "email" | "note" | "system";
  text: string;
  deal_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  at: string;
  by_id: string | null;
  by_name: string;
  event: string | null;
  data: string | null;
}

interface TaskRow {
  id: string;
  text: string;
  deal_id: string | null;
  contact_id: string | null;
  owner_id: string | null;
  owner_name: string | null;
  due_date: string;
  due_time: string | null;
  remind_at: string | null;
  reminded_at: string | null;
  done_at: string | null;
  done_by: string | null;
  created_at: string;
  created_by: string;
}

interface QuoteRow {
  id: string;
  number: string;
  deal_id: string;
  state: "draft" | "sent" | "accepted" | "declined";
  currency: string;
  vat: number;
  valid_until: string;
  notes: string | null;
  seller: string;
  created_at: string;
  created_by: string;
  sent_at: string | null;
  decided_at: string | null;
}

interface LineRow {
  pos: number;
  item: string;
  quantity: number;
  unit_minor: number;
  discount: number;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
}

export type ActivityKind = "call" | "meeting" | "email" | "note";
const KINDS: ActivityKind[] = ["call", "meeting", "email", "note"];
const SOURCES: Record<string, string> = {
  manual: "Added by hand",
  import: "CSV import",
  api: "API",
  "live-chat": "Live Chat",
  forms: "Forms",
  "meeting-link": "Meeting link",
};

export interface CrmOptions {
  /** The address people open CRM at, for links in what other products are sent. */
  publicUrl: string;
  env?: Record<string, string | undefined>;
  clock?: () => number;
  fileState?: () => ConfigFileState | null;
  /** For tests: what talks to Audience, Messages and the mail server, instead of the real clients. */
  audience?: (c: Config) => AudienceLink | null;
  messages?: (c: Config) => MessagesLink | null;
  mailer?: (c: Config) => Mailer | null;
}

interface LinkState {
  okAt: string | null;
  errorAt: string | null;
  error: string | null;
}

export function createCrm(db: DatabaseSync, opts: CrmOptions) {
  const clock = opts.clock ?? Date.now;
  const env = opts.env ?? process.env;
  const store = createStore(db, clock);
  const { q, one, run, tx, iso } = store;
  let config: Config | null = null;
  let configText = "";
  let audience: AudienceLink | null = null;
  let messages: MessagesLink | null = null;
  let mailer: Mailer | null = null;
  const links: Record<"audience" | "messages" | "mail", LinkState> = {
    audience: { okAt: null, errorAt: null, error: null },
    messages: { okAt: null, errorAt: null, error: null },
    mail: { okAt: null, errorAt: null, error: null },
  };
  const linkOk = (k: keyof typeof links) => Object.assign(links[k], { okAt: iso(), error: null });
  const linkFailed = (k: keyof typeof links, err: unknown) =>
    Object.assign(links[k], { errorAt: iso(), error: err instanceof Error ? err.message : String(err) });
  const counters = { outbox: new Map<string, number>(), reminders: new Map<string, number>(), bookings: new Map<string, number>() };
  const count = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

  // ------------------------------------------------------------------ settings

  function cfg(): Config {
    if (!config) throw new CrmError(503, "not-available", "The settings file is not applied yet.");
    return config;
  }

  const team = (): Member[] => {
    try {
      return q<Member>("SELECT id, name, email, role FROM auth_users WHERE status != 'disabled' ORDER BY name COLLATE NOCASE");
    } catch {
      return [];
    }
  };
  const memberByEmail = (email: string | null | undefined) => (email ? team().find((m) => m.email.toLowerCase() === email.toLowerCase()) : undefined);
  const memberEmail = (id: string | null) => (id ? (team().find((m) => m.id === id)?.email ?? null) : null);

  function setConfig(c: Config, raw: string): string[] {
    config = c;
    configText = raw;
    mailer?.close();
    mailer = opts.mailer ? opts.mailer(c) : c.mail ? smtpMailer(c.mail, env[c.mail.password]) : null;
    audience = opts.audience ? opts.audience(c) : c.audience ? audienceLink({ url: c.audience.url, token: env[c.audience.token] }) : null;
    messages = opts.messages ? opts.messages(c) : c.messages ? messagesLink({ url: c.messages.url, token: env[c.messages.token] }) : null;
    const warnings = configWarnings(
      c,
      env,
      team().map((m) => m.email.toLowerCase()),
    );
    // Open deals in stages the file no longer has stay where they are; they are listed so someone moves them.
    for (const r of q<{ pipeline: string; stage: string; n: number }>(
      "SELECT pipeline, stage, COUNT(*) AS n FROM deals WHERE status = 'open' GROUP BY pipeline, stage",
    )) {
      const p = c.pipelines.find((x) => x.id === r.pipeline);
      if (!p) warnings.push(`${r.n} open deals are in the pipeline ${r.pipeline}, which the file no longer has.`);
      else if (!p.stages.some((s) => s.id === r.stage))
        warnings.push(`${r.n} open deals are in the stage ${r.pipeline}/${r.stage}, which the file no longer has.`);
    }
    return warnings;
  }

  function settings() {
    const c = config;
    return {
      file: opts.fileState?.() ?? null,
      yaml: configText,
      config: c && {
        currency: c.currency,
        timeZone: c.timeZone,
        pipelines: c.pipelines,
        plans: c.plans,
        leads: c.leads,
        quotes: { vat: c.quotes.vat, validDays: c.quotes.validDays, language: c.quotes.language, seller: c.quotes.seller, terms: c.quotes.terms },
        tasks: { remindAt: `${String(Math.floor(c.tasks.remindAt / 60)).padStart(2, "0")}:${String(c.tasks.remindAt % 60).padStart(2, "0")}` },
        mail: c.mail && { host: c.mail.host, port: c.mail.port, security: c.mail.security, from: c.mail.from, password: c.mail.password },
        audience: c.audience,
        messages: c.messages,
      },
    };
  }

  // ------------------------------------------------------------------ ownership

  const canChange = (who: Actor, ownerId: string | null) =>
    atLeast(who.role, "admin") || (atLeast(who.role, "editor") && (ownerId === null || ownerId === who.id));
  function mustChange(who: Actor, row: { owner_id: string | null; owner_name: string | null }, what: string) {
    if (!canChange(who, row.owner_id))
      throw new CrmError(403, "forbidden", `This ${what} is ${row.owner_name ?? "someone else"}'s; only its owner or an admin changes it.`);
  }
  /** The member an owner field names, by id; null clears it. Editors give records to others only when creating or giving away their own. */
  function ownerFrom(v: unknown, field = "owner"): { id: string; name: string } | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    if (typeof v !== "string") throw bad(`${field} is a member's id, or null for nobody.`);
    const m = team().find((x) => x.id === v || x.email.toLowerCase() === v.toLowerCase());
    if (!m) throw bad(`${field}: ${v} is not a member of CRM.`);
    return { id: m.id, name: m.name };
  }
  /** Who owns what an actor creates without naming an owner: themselves when they are a member. */
  const selfOwner = (who: Actor) => (team().some((m) => m.id === who.id) ? { id: who.id, name: who.name } : null);
  const ownerOut = (id: string | null, name: string | null) => (id ? { id, name: name ?? "" } : null);

  // ------------------------------------------------------------------ pipelines and stages

  const pipelineOf = (id: string): Pipeline | undefined => cfg().pipelines.find((p) => p.id === id);
  const stageOf = (pipeline: string, stage: string): Stage | undefined => pipelineOf(pipeline)?.stages.find((s) => s.id === stage);
  function mustStage(pipeline: string, stage: string): Stage {
    const p = pipelineOf(pipeline);
    if (!p)
      throw bad(
        `pipeline: ${pipeline} is not a pipeline in the settings file; it has ${cfg()
          .pipelines.map((x) => x.id)
          .join(", ")}.`,
      );
    const s = p.stages.find((x) => x.id === stage);
    if (!s) throw bad(`stage: ${stage} is not a stage of ${p.id}; it has ${p.stages.map((x) => x.id).join(", ")}.`);
    return s;
  }
  /** The share of its value a deal counts for: its stage's probability while open, all of it won, nothing lost. */
  const probability = (d: DealRow) => (d.status === "won" ? 100 : d.status === "lost" ? 0 : (stageOf(d.pipeline, d.stage)?.probability ?? 0));
  const quietDays = (d: DealRow) => Math.max(0, Math.floor((clock() - Date.parse(d.last_activity_at)) / DAY));
  /** Stale: open, and no activity for longer than its stage allows. */
  const isStale = (d: DealRow) => {
    const s = d.status === "open" ? stageOf(d.pipeline, d.stage) : undefined;
    return !!s && s.staleDays !== null && quietDays(d) > s.staleDays;
  };
  const month = (ms: number) => {
    const l = localDate(ms, cfg().timeZone);
    return `${l.year}-${String(l.month).padStart(2, "0")}`;
  };
  const today = () => {
    const l = localDate(clock(), cfg().timeZone);
    return `${l.year}-${String(l.month).padStart(2, "0")}-${String(l.day).padStart(2, "0")}`;
  };
  /**
   * The month a deal counts in for the forecast: the month it was won in, or for an open deal the month it is expected
   * to close in. An open deal whose expected close is in a past month counts in this month: it has not closed, so it
   * is still expected, and it shows as overdue. null: no expected close date, so in no month.
   */
  function forecastMonth(d: DealRow): string | null {
    if (d.status === "won") return d.closed_at ? month(Date.parse(d.closed_at)) : null;
    if (d.status === "lost" || !d.expected_close) return null;
    const now = month(clock());
    const m = d.expected_close.slice(0, 7);
    return m < now ? now : m;
  }

  // ------------------------------------------------------------------ the API's shapes

  const companyName = (id: string | null) => (id ? (one<{ name: string }>("SELECT name FROM companies WHERE id = ?", id)?.name ?? null) : null);

  function companyOut(c: CompanyRow, who?: Actor) {
    const plan = c.plan ? (cfg().plans.find((p) => p.id === c.plan) ?? { id: c.plan, name: c.plan }) : null;
    const stats = one<{ contacts: number }>("SELECT COUNT(*) AS contacts FROM contacts WHERE company_id = ?", c.id)!;
    const open = one<{ n: number; v: number }>(
      "SELECT COUNT(*) AS n, COALESCE(SUM(value_minor), 0) AS v FROM deals WHERE company_id = ? AND status = 'open'",
      c.id,
    )!;
    return {
      id: c.id,
      name: c.name,
      domain: c.domain,
      sector: c.sector,
      city: c.city,
      plan,
      planRenews: c.plan_renews,
      users: c.users,
      owner: ownerOut(c.owner_id, c.owner_name),
      contacts: stats.contacts,
      openDeals: open.n,
      openValue: money(open.v),
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      canEdit: who ? canChange(who, c.owner_id) : false,
    };
  }

  function contactOut(c: ContactRow, who?: Actor) {
    const open = one<{ n: number }>("SELECT COUNT(*) AS n FROM deals WHERE contact_id = ? AND status = 'open'", c.id)!;
    return {
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      title: c.title,
      company: c.company_id ? { id: c.company_id, name: companyName(c.company_id) ?? "" } : null,
      owner: ownerOut(c.owner_id, c.owner_name),
      source: c.source,
      openDeals: open.n,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      canEdit: who ? canChange(who, c.owner_id) : false,
    };
  }

  function dealOut(d: DealRow, who?: Actor) {
    const s = stageOf(d.pipeline, d.stage);
    const contact = d.contact_id
      ? one<{ id: string; name: string; email: string | null }>("SELECT id, name, email FROM contacts WHERE id = ?", d.contact_id)
      : undefined;
    const p = probability(d);
    return {
      id: d.id,
      name: d.name,
      pipeline: d.pipeline,
      stage: {
        id: d.stage,
        name: s?.name ?? (d.stage === "won" ? "Won" : d.stage === "lost" ? "Lost" : d.stage),
        probability: p,
        inFile: !!s || d.status !== "open",
      },
      status: d.status,
      value: money(d.value_minor),
      weighted: money(Math.round((d.value_minor * p) / 100)),
      currency: d.currency,
      company: d.company_id ? { id: d.company_id, name: companyName(d.company_id) ?? "" } : null,
      contact: contact ?? null,
      owner: ownerOut(d.owner_id, d.owner_name),
      expectedClose: d.expected_close,
      forecastMonth: config ? forecastMonth(d) : null,
      overdue: d.status === "open" && !!d.expected_close && d.expected_close < today(),
      source: d.source,
      sourceName: SOURCES[d.source] ?? d.source,
      sourceDetail: d.source_detail,
      reason: d.reason,
      reasonNote: d.reason_note,
      closedAt: d.closed_at,
      stageEnteredAt: d.stage_entered_at,
      lastActivityAt: d.last_activity_at,
      quietDays: quietDays(d),
      stale: isStale(d),
      staleAfter: d.status === "open" ? (s?.staleDays ?? null) : null,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
      canEdit: who ? canChange(who, d.owner_id) : false,
    };
  }

  function activityOut(a: ActivityRow) {
    const deal = a.deal_id ? one<{ id: string; name: string }>("SELECT id, name FROM deals WHERE id = ?", a.deal_id) : undefined;
    const contact = a.contact_id ? one<{ id: string; name: string }>("SELECT id, name FROM contacts WHERE id = ?", a.contact_id) : undefined;
    return {
      id: a.id,
      kind: a.kind,
      text: a.text,
      at: a.at,
      by: { id: a.by_id, name: a.by_name },
      deal: deal ?? null,
      contact: contact ?? null,
      company: a.company_id ? { id: a.company_id, name: companyName(a.company_id) ?? "" } : null,
      event: a.event,
      data: a.data ? (JSON.parse(a.data) as Record<string, unknown>) : null,
    };
  }

  function taskOut(t: TaskRow) {
    const deal = t.deal_id ? one<DealRow>("SELECT * FROM deals WHERE id = ?", t.deal_id) : undefined;
    const contact = t.contact_id ? one<{ id: string; name: string }>("SELECT id, name FROM contacts WHERE id = ?", t.contact_id) : undefined;
    const now = config ? today() : t.due_date;
    return {
      id: t.id,
      text: t.text,
      due: t.due_date,
      time: t.due_time,
      overdue: !t.done_at && t.due_date < now,
      dueToday: !t.done_at && t.due_date === now,
      deal: deal ? { id: deal.id, name: deal.name, company: companyName(deal.company_id) } : null,
      contact: contact ?? null,
      owner: ownerOut(t.owner_id, t.owner_name),
      remindAt: t.remind_at,
      remindedAt: t.reminded_at,
      doneAt: t.done_at,
      doneBy: t.done_by,
      createdAt: t.created_at,
      createdBy: t.created_by,
    };
  }

  // ------------------------------------------------------------------ Audience and Messages, through the outbox

  /** Queues an event for Audience about a contact: nothing when Audience is not linked or the contact has no email or phone. */
  function toAudience(type: string, id: string, contact: ContactRow | undefined, properties: Record<string, unknown>, textLine: string) {
    const c = config;
    if (!c?.audience?.events || !contact || (!contact.email && !contact.phone)) return;
    const event: AudienceEvent = {
      source: "crm",
      type,
      id,
      at: iso(),
      person: { email: contact.email, phone: contact.phone, name: contact.name },
      properties,
      text: textLine.slice(0, 300),
    };
    run(
      "INSERT INTO outbox (target, event, email, phone, created_at, next_at) VALUES ('audience', ?, ?, ?, ?, ?)",
      JSON.stringify(event),
      contact.email,
      phoneKey(contact.phone),
      iso(),
      iso(),
    );
  }

  function toMessages(type: string, contact: ContactRow | undefined, fields: Record<string, string | number>) {
    const c = config;
    if (!c?.messages || !contact?.email) return;
    const event: MessagesEvent = { type, person: { email: contact.email, name: contact.name, ...(contact.phone && { phone: contact.phone }), fields } };
    run(
      "INSERT INTO outbox (target, event, email, phone, created_at, next_at) VALUES ('messages', ?, ?, ?, ?, ?)",
      JSON.stringify(event),
      contact.email,
      phoneKey(contact.phone),
      iso(),
      iso(),
    );
  }

  const contactRow = (id: string | null) => (id ? one<ContactRow>("SELECT * FROM contacts WHERE id = ?", id) : undefined);
  function dealProps(d: DealRow) {
    return {
      deal: d.name,
      deal_id: d.id,
      pipeline: d.pipeline,
      stage: stageOf(d.pipeline, d.stage)?.name ?? d.stage,
      status: d.status,
      value: money(d.value_minor),
      currency: d.currency,
      company: companyName(d.company_id),
    };
  }

  const OUTBOX_KEEP = 3 * DAY;
  let flushing: Promise<void> | null = null;
  /** Sends what is due, up to 100 events a product a round; failures wait 1, 2, 4 minutes and so on, up to 6 hours. */
  function flush(): Promise<void> {
    if (flushing) return flushing;
    flushing = (async () => {
      for (const target of ["audience", "messages"] as const) {
        const link = target === "audience" ? audience : messages;
        if (!link) continue;
        const due = q<{ id: number; event: string; attempts: number; created_at: string }>(
          "SELECT id, event, attempts, created_at FROM outbox WHERE target = ? AND next_at <= ? ORDER BY id LIMIT 100",
          target,
          iso(),
        );
        if (!due.length) continue;
        // A batch is taken or refused whole; after a refusal each event goes alone, so one bad event holds back only itself.
        const batch = due.some((d) => d.attempts > 0) ? due.slice(0, 1) : due;
        try {
          await (target === "audience"
            ? (link as AudienceLink).send(batch.map((d) => JSON.parse(d.event) as AudienceEvent))
            : (link as MessagesLink).send(batch.map((d) => JSON.parse(d.event) as MessagesEvent)));
          tx(() => {
            for (const d of batch) run("DELETE FROM outbox WHERE id = ?", d.id);
          });
          linkOk(target);
          count(counters.outbox, `${target}:sent`, batch.length);
        } catch (err) {
          linkFailed(target, err);
          const e = err instanceof LinkError ? err : new LinkError(String(err));
          const auth = e.status === 401 || e.status === 403 || e.message.includes("token is not set");
          tx(() => {
            for (const d of batch) {
              const old = clock() - Date.parse(d.created_at) > OUTBOX_KEEP;
              // A refused event is dropped when it was sent alone; a refused token waits for someone to fix it.
              if (old || (e.permanent && !auth && batch.length === 1)) {
                run("DELETE FROM outbox WHERE id = ?", d.id);
                count(counters.outbox, `${target}:dropped`);
                log("warn", `an event for ${target} was dropped`, { error: e.message, old });
              } else {
                const wait = auth ? 10 * MINUTE : Math.min(6 * 60 * MINUTE, MINUTE * 2 ** Math.min(d.attempts, 9));
                run(
                  "UPDATE outbox SET attempts = attempts + 1, error = ?, next_at = ? WHERE id = ?",
                  e.message.slice(0, 300),
                  iso(clock() + (e.permanent && !auth ? 0 : wait)),
                  d.id,
                );
              }
            }
          });
        }
      }
    })().finally(() => (flushing = null));
    return flushing;
  }

  // ------------------------------------------------------------------ activities

  function addActivity(a: {
    kind: ActivityRow["kind"];
    text: string;
    deal?: string | null;
    contact?: string | null;
    company?: string | null;
    at?: string;
    by: { id: string | null; name: string };
    event?: string;
    data?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    const at = a.at ?? iso();
    run(
      "INSERT INTO activities (id, kind, text, deal_id, contact_id, company_id, at, by_id, by_name, event, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      a.kind,
      a.text,
      a.deal ?? null,
      a.contact ?? null,
      a.company ?? null,
      at,
      a.by.id,
      a.by.name,
      a.event ?? null,
      a.data ? JSON.stringify(a.data) : null,
      iso(),
    );
    // Anything done on a deal is activity: what stale is measured from.
    if (a.deal) run("UPDATE deals SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?", at > iso() ? iso() : at, a.deal);
    return id;
  }

  function listActivities(f: { deal?: string; contact?: string; company?: string }, limit = 200) {
    if (f.deal) return q<ActivityRow>("SELECT * FROM activities WHERE deal_id = ? ORDER BY at DESC, created_at DESC LIMIT ?", f.deal, limit).map(activityOut);
    if (f.contact)
      return q<ActivityRow>(
        "SELECT * FROM activities WHERE contact_id = ? OR deal_id IN (SELECT id FROM deals WHERE contact_id = ?) ORDER BY at DESC, created_at DESC LIMIT ?",
        f.contact,
        f.contact,
        limit,
      ).map(activityOut);
    if (f.company)
      return q<ActivityRow>(
        `SELECT * FROM activities WHERE company_id = ? OR deal_id IN (SELECT id FROM deals WHERE company_id = ?)
           OR contact_id IN (SELECT id FROM contacts WHERE company_id = ?) ORDER BY at DESC, created_at DESC LIMIT ?`,
        f.company,
        f.company,
        f.company,
        limit,
      ).map(activityOut);
    return q<ActivityRow>("SELECT * FROM activities ORDER BY at DESC, created_at DESC LIMIT ?", limit).map(activityOut);
  }

  function logActivity(who: Actor, raw: unknown) {
    const b = body(raw, ["kind", "text", "deal", "contact", "company", "at"]);
    if (!KINDS.includes(b.kind as ActivityKind)) throw bad(`kind is ${KINDS.join(", ")}.`);
    const t = text(b.text, "text", 5000);
    let at = iso();
    if (b.at !== undefined) {
      const ms = typeof b.at === "string" ? Date.parse(b.at) : NaN;
      if (Number.isNaN(ms) || ms > clock() + DAY) throw bad("at is a date-time, at most a day ahead.");
      at = iso(ms);
    }
    const deal = b.deal === undefined ? undefined : mustDeal(String(b.deal));
    const contact = b.contact === undefined ? undefined : mustContact(String(b.contact));
    const company = b.company === undefined ? undefined : mustCompany(String(b.company));
    if (!deal && !contact && !company) throw bad("Name what the activity is about: deal, contact or company.");
    for (const [row, what] of [
      [deal, "deal"],
      [contact, "contact"],
      [company, "company"],
    ] as const)
      if (row) mustChange(who, row, what);
    return tx(() => {
      const id = addActivity({
        kind: b.kind as ActivityKind,
        text: t,
        deal: deal?.id ?? null,
        contact: contact?.id ?? deal?.contact_id ?? null,
        company: company?.id ?? null,
        at,
        by: { id: who.id, name: who.name },
      });
      return activityOut(one<ActivityRow>("SELECT * FROM activities WHERE id = ?", id)!);
    });
  }

  function removeActivity(who: Actor, id: string) {
    const a = one<ActivityRow>("SELECT * FROM activities WHERE id = ?", id);
    if (!a) throw notFound("The activity");
    if (a.kind === "system") throw new CrmError(409, "conflict", "What CRM noted itself stays in the history.");
    if (a.by_id !== who.id && !atLeast(who.role, "admin")) throw new CrmError(403, "forbidden", "Only who logged an activity, or an admin, removes it.");
    run("DELETE FROM activities WHERE id = ?", id);
  }

  // ------------------------------------------------------------------ companies

  const mustCompany = (id: string) =>
    one<CompanyRow>("SELECT * FROM companies WHERE id = ?", id) ??
    (() => {
      throw notFound("The company");
    })();
  const mustContact = (id: string) =>
    one<ContactRow>("SELECT * FROM contacts WHERE id = ?", id) ??
    (() => {
      throw notFound("The contact");
    })();
  const mustDeal = (id: string) =>
    one<DealRow>("SELECT * FROM deals WHERE id = ?", id) ??
    (() => {
      throw notFound("The deal");
    })();

  function planFrom(v: unknown): string | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const p = cfg().plans.find((x) => x.id === v || x.name.toLowerCase() === String(v).toLowerCase());
    if (!p)
      throw bad(
        `plan is one of the settings file's plans: ${
          cfg()
            .plans.map((x) => x.id)
            .join(", ") || "none"
        }.`,
      );
    return p.id;
  }
  function usersFrom(v: unknown): number | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 10_000_000) throw bad("users is a whole number of seats.");
    return n;
  }

  const COMPANY_FIELDS = ["name", "domain", "sector", "city", "plan", "planRenews", "users", "owner"];
  function companyValues(b: Record<string, unknown>) {
    const domain = optText(b.domain, "domain", 253);
    if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) throw bad("domain is a domain name, such as avcilojistik.com.tr.");
    return {
      name: b.name === undefined ? undefined : text(b.name, "name", 120),
      domain: domain?.toLowerCase() ?? domain,
      sector: optText(b.sector, "sector", 80),
      city: optText(b.city, "city", 80),
      plan: planFrom(b.plan),
      plan_renews: optDay(b.planRenews, "planRenews"),
      users: usersFrom(b.users),
    };
  }

  function listCompanies(who: Actor, query: URLSearchParams) {
    const s = (query.get("q") ?? "").trim().toLocaleLowerCase("tr");
    return q<CompanyRow>("SELECT * FROM companies ORDER BY name COLLATE NOCASE")
      .filter((c) => !s || `${c.name} ${c.city ?? ""} ${c.sector ?? ""} ${c.domain ?? ""}`.toLocaleLowerCase("tr").includes(s))
      .map((c) => companyOut(c, who));
  }

  function createCompany(who: Actor, raw: unknown) {
    const b = body(raw, COMPANY_FIELDS);
    const v = companyValues(b);
    if (!v.name) throw bad("name is a text of 1 to 120 characters.");
    const owner = b.owner === undefined ? selfOwner(who) : ownerFrom(b.owner);
    return tx(() => {
      const dup = one<{ id: string }>("SELECT id FROM companies WHERE name = ? COLLATE NOCASE", v.name!);
      if (dup) throw new CrmError(409, "conflict", `A company named ${v.name} exists already.`);
      const id = randomUUID();
      run(
        "INSERT INTO companies (id, name, domain, sector, city, plan, plan_renews, users, owner_id, owner_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        v.name!,
        v.domain ?? null,
        v.sector ?? null,
        v.city ?? null,
        v.plan ?? null,
        v.plan_renews ?? null,
        v.users ?? null,
        owner?.id ?? null,
        owner?.name ?? null,
        iso(),
        iso(),
      );
      return companyOut(mustCompany(id), who);
    });
  }

  function updateCompany(who: Actor, id: string, raw: unknown) {
    const c = mustCompany(id);
    mustChange(who, c, "company");
    const b = body(raw, COMPANY_FIELDS);
    const v = companyValues(b);
    const owner = ownerFrom(b.owner);
    return tx(() => {
      if (v.name && v.name.toLowerCase() !== c.name.toLowerCase() && one("SELECT id FROM companies WHERE name = ? COLLATE NOCASE AND id != ?", v.name, id))
        throw new CrmError(409, "conflict", `A company named ${v.name} exists already.`);
      const set: Record<string, string | number | null> = {};
      for (const [k, x] of Object.entries(v)) if (x !== undefined) set[k] = x;
      if (owner !== undefined) Object.assign(set, { owner_id: owner?.id ?? null, owner_name: owner?.name ?? null });
      patch("companies", id, set);
      return companyOut(mustCompany(id), who);
    });
  }

  function patch(table: "companies" | "contacts" | "deals" | "tasks", id: string, set: Record<string, string | number | null>) {
    const cols = Object.keys(set);
    if (!cols.length) return;
    if (table !== "tasks") set.updated_at = iso();
    run(
      `UPDATE ${table} SET ${Object.keys(set)
        .map((k) => `${k} = ?`)
        .join(", ")} WHERE id = ?`,
      ...Object.values(set),
      id,
    );
  }

  function removeCompany(who: Actor, id: string) {
    const c = mustCompany(id);
    mustChange(who, c, "company");
    run("DELETE FROM companies WHERE id = ?", id);
  }

  function getCompany(who: Actor, id: string) {
    const c = mustCompany(id);
    return {
      ...companyOut(c, who),
      people: q<ContactRow>("SELECT * FROM contacts WHERE company_id = ? ORDER BY name COLLATE NOCASE", id).map((x) => contactOut(x, who)),
      deals: q<DealRow>("SELECT * FROM deals WHERE company_id = ? ORDER BY status = 'open' DESC, updated_at DESC", id).map((d) => dealOut(d, who)),
      activities: listActivities({ company: id }, 100),
    };
  }

  /** The company with this name, made when there is none. */
  function companyByName(name: string, owner: { id: string; name: string } | null): string {
    const found = one<{ id: string }>("SELECT id FROM companies WHERE name = ? COLLATE NOCASE", name);
    if (found) return found.id;
    const id = randomUUID();
    run(
      "INSERT INTO companies (id, name, owner_id, owner_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      name.slice(0, 120),
      owner?.id ?? null,
      owner?.name ?? null,
      iso(),
      iso(),
    );
    return id;
  }

  // ------------------------------------------------------------------ contacts

  const CONTACT_FIELDS = ["name", "email", "phone", "title", "company", "companyName", "owner"];

  function listContacts(who: Actor, query: URLSearchParams) {
    const s = (query.get("q") ?? "").trim().toLocaleLowerCase("tr");
    const company = query.get("company");
    return (
      company
        ? q<ContactRow>("SELECT * FROM contacts WHERE company_id = ? ORDER BY name COLLATE NOCASE", company)
        : q<ContactRow>("SELECT * FROM contacts ORDER BY name COLLATE NOCASE")
    )
      .filter((c) => !s || `${c.name} ${c.email ?? ""} ${c.phone ?? ""} ${companyName(c.company_id) ?? ""}`.toLocaleLowerCase("tr").includes(s))
      .map((c) => contactOut(c, who));
  }

  function contactValues(b: Record<string, unknown>) {
    const phone = optText(b.phone, "phone", 40);
    if (phone && !phoneKey(phone)) throw bad("phone is a phone number, such as +90 532 000 00 12.");
    return { name: b.name === undefined ? undefined : text(b.name, "name", 120), email: optEmail(b.email), phone, title: optText(b.title, "title", 120) };
  }

  function companyField(b: Record<string, unknown>, owner: { id: string; name: string } | null): string | null | undefined {
    if (b.company !== undefined && b.company !== null && b.company !== "") return mustCompany(String(b.company)).id;
    if (b.company === null || b.company === "") return null;
    const n = optText(b.companyName, "companyName", 120);
    return n ? companyByName(n, owner) : n;
  }

  function emailTaken(email: string, except?: string) {
    const c = one<{ id: string; name: string }>("SELECT id, name FROM contacts WHERE email = ? AND id != ?", email, except ?? "");
    if (c) throw new CrmError(409, "conflict", `${c.name} has the email ${email} already; a contact's email is theirs only.`);
  }

  function createContact(who: Actor, raw: unknown, source = "manual") {
    const b = body(raw, CONTACT_FIELDS);
    const v = contactValues(b);
    if (!v.name) throw bad("name is a text of 1 to 120 characters.");
    const owner = b.owner === undefined ? selfOwner(who) : ownerFrom(b.owner)!;
    return tx(() => {
      if (v.email) emailTaken(v.email);
      const company = companyField(b, owner ?? null);
      const id = insertContact({
        name: v.name!,
        email: v.email ?? null,
        phone: v.phone ?? null,
        title: v.title ?? null,
        company: company ?? null,
        owner: owner ?? null,
        source,
      });
      return contactOut(mustContact(id), who);
    });
  }

  function insertContact(c: {
    name: string;
    email: string | null;
    phone: string | null;
    title: string | null;
    company: string | null;
    owner: { id: string; name: string } | null;
    source: string;
  }) {
    const id = randomUUID();
    run(
      "INSERT INTO contacts (id, name, email, phone, title, company_id, owner_id, owner_name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      c.name,
      c.email,
      c.phone,
      c.title,
      c.company,
      c.owner?.id ?? null,
      c.owner?.name ?? null,
      c.source,
      iso(),
      iso(),
    );
    const row = mustContact(id);
    toAudience(
      "contact_created",
      `contact-${id}:created`,
      row,
      { company: companyName(row.company_id), title: row.title, source: row.source },
      `Added to CRM as a contact of ${companyName(row.company_id) ?? "no company"}`,
    );
    return id;
  }

  function updateContact(who: Actor, id: string, raw: unknown) {
    const c = mustContact(id);
    mustChange(who, c, "contact");
    const b = body(raw, CONTACT_FIELDS);
    const v = contactValues(b);
    const owner = ownerFrom(b.owner);
    return tx(() => {
      if (v.email) emailTaken(v.email, id);
      const set: Record<string, string | number | null> = {};
      for (const [k, x] of Object.entries(v)) if (x !== undefined) set[k] = x;
      const company = companyField(b, c.owner_id ? { id: c.owner_id, name: c.owner_name ?? "" } : null);
      if (company !== undefined) set.company_id = company;
      if (owner !== undefined) Object.assign(set, { owner_id: owner?.id ?? null, owner_name: owner?.name ?? null });
      patch("contacts", id, set);
      const after = mustContact(id);
      const changed = (["name", "email", "phone", "title", "company_id"] as const).filter((k) => after[k] !== c[k]);
      if (changed.length)
        toAudience(
          "contact_changed",
          `contact-${id}:changed:${after.updated_at}`,
          after,
          { changed, company: companyName(after.company_id), title: after.title },
          `Contact changed in CRM: ${changed.join(", ")}`,
        );
      return contactOut(after, who);
    });
  }

  function removeContact(who: Actor, id: string) {
    const c = mustContact(id);
    mustChange(who, c, "contact");
    run("DELETE FROM contacts WHERE id = ?", id);
  }

  function getContact(who: Actor, id: string) {
    const c = mustContact(id);
    return {
      ...contactOut(c, who),
      deals: q<DealRow>("SELECT * FROM deals WHERE contact_id = ? ORDER BY status = 'open' DESC, updated_at DESC", id).map((d) => dealOut(d, who)),
      activities: listActivities({ contact: id }, 100),
      tasks: q<TaskRow>(
        "SELECT * FROM tasks WHERE contact_id = ? OR deal_id IN (SELECT id FROM deals WHERE contact_id = ?) ORDER BY done_at IS NOT NULL, due_date",
        id,
        id,
      ).map(taskOut),
    };
  }

  // ------------------------------------------------------------------ deals

  const DEAL_FIELDS = ["name", "pipeline", "stage", "value", "company", "companyName", "contact", "owner", "expectedClose", "source"];

  function listDeals(who: Actor, query: URLSearchParams) {
    const status = query.get("status") ?? "open";
    if (!["open", "won", "lost", "all"].includes(status)) throw bad("status is open, won, lost or all.");
    const pipeline = query.get("pipeline");
    const owner = query.get("owner");
    const s = (query.get("q") ?? "").trim().toLocaleLowerCase("tr");
    const rows = q<DealRow>(
      `SELECT * FROM deals WHERE (? = 'all' OR status = ?) AND (? IS NULL OR pipeline = ?) ORDER BY ${status === "open" ? "value_minor DESC" : "COALESCE(closed_at, updated_at) DESC"}`,
      status,
      status,
      pipeline,
      pipeline,
    );
    return rows
      .filter((d) => !owner || (owner === "me" ? d.owner_id === who.id : owner === "none" ? d.owner_id === null : d.owner_id === owner))
      .map((d) => dealOut(d, who))
      .filter((d) => !s || `${d.name} ${d.company?.name ?? ""} ${d.contact?.name ?? ""} ${d.contact?.email ?? ""}`.toLocaleLowerCase("tr").includes(s));
  }

  function insertDeal(d: {
    name: string;
    pipeline: string;
    stage: string;
    valueMinor: number;
    company: string | null;
    contact: string | null;
    owner: { id: string; name: string } | null;
    expectedClose: string | null;
    source: string;
    sourceDetail?: string | null;
    externalId?: string | null;
    by: string;
  }) {
    const id = randomUUID();
    const now = iso();
    run(
      `INSERT INTO deals (id, name, pipeline, stage, status, value_minor, currency, company_id, contact_id, owner_id, owner_name, expected_close, source,
         source_detail, stage_entered_at, last_activity_at, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      d.name,
      d.pipeline,
      d.stage,
      d.valueMinor,
      cfg().currency,
      d.company,
      d.contact,
      d.owner?.id ?? null,
      d.owner?.name ?? null,
      d.expectedClose,
      d.source,
      d.sourceDetail ?? null,
      now,
      now,
      d.externalId ?? null,
      now,
      now,
    );
    run("INSERT INTO stage_history (deal_id, pipeline, stage, entered_at, by_name) VALUES (?, ?, ?, ?, ?)", id, d.pipeline, d.stage, now, d.by);
    const row = mustDeal(id);
    toAudience(
      "deal_opened",
      `deal-${id}:opened`,
      contactRow(row.contact_id),
      dealProps(row),
      `Deal ${row.name} opened in ${stageOf(row.pipeline, row.stage)?.name ?? row.stage}`,
    );
    return id;
  }

  function createDeal(who: Actor, raw: unknown, source = "manual") {
    const b = body(raw, DEAL_FIELDS);
    const c = cfg();
    const name = text(b.name, "name", 200);
    const pipeline = b.pipeline === undefined ? c.pipelines[0]!.id : String(b.pipeline);
    const stage = b.stage === undefined ? (pipelineOf(pipeline)?.stages[0]?.id ?? "") : String(b.stage);
    mustStage(pipeline, stage);
    const owner = b.owner === undefined ? selfOwner(who) : ownerFrom(b.owner)!;
    const src = b.source === undefined ? source : String(b.source);
    if (!/^[a-z0-9-]{1,32}$/.test(src)) throw bad("source is a short id such as manual, api, forms or live-chat.");
    return tx(() => {
      const contact = b.contact === undefined || b.contact === null ? null : mustContact(String(b.contact));
      const company = companyField(b, owner ?? null) ?? contact?.company_id ?? null;
      const id = insertDeal({
        name,
        pipeline,
        stage,
        valueMinor: b.value === undefined ? 0 : amount(b.value, "value"),
        company,
        contact: contact?.id ?? null,
        owner: owner ?? null,
        expectedClose: optDay(b.expectedClose, "expectedClose") ?? null,
        source: src,
        by: who.name,
      });
      return dealOut(mustDeal(id), who);
    });
  }

  function updateDeal(who: Actor, id: string, raw: unknown) {
    const d = mustDeal(id);
    mustChange(who, d, "deal");
    const b = body(raw, ["name", "value", "company", "companyName", "contact", "owner", "expectedClose"]);
    const owner = ownerFrom(b.owner);
    return tx(() => {
      const set: Record<string, string | number | null> = {};
      if (b.name !== undefined) set.name = text(b.name, "name", 200);
      if (b.value !== undefined) set.value_minor = amount(b.value, "value");
      const ec = optDay(b.expectedClose, "expectedClose");
      if (ec !== undefined) set.expected_close = ec;
      const company = companyField(b, d.owner_id ? { id: d.owner_id, name: d.owner_name ?? "" } : null);
      if (company !== undefined) set.company_id = company;
      if (b.contact !== undefined) set.contact_id = b.contact === null || b.contact === "" ? null : mustContact(String(b.contact)).id;
      if (owner !== undefined && (owner?.id ?? null) !== d.owner_id) {
        Object.assign(set, { owner_id: owner?.id ?? null, owner_name: owner?.name ?? null });
        addActivity({
          kind: "system",
          text: `Owner: ${owner?.name ?? "nobody"}`,
          deal: id,
          by: who,
          event: "owner",
          data: { from: d.owner_name, to: owner?.name ?? null },
        });
      }
      patch("deals", id, set);
      return dealOut(mustDeal(id), who);
    });
  }

  /** Closes the deal's current stage in the history and opens the next. */
  function enterStage(d: DealRow, pipeline: string, stage: string, who: Actor) {
    const now = iso();
    run("UPDATE stage_history SET left_at = ? WHERE deal_id = ? AND left_at IS NULL", now, d.id);
    const h = run("INSERT INTO stage_history (deal_id, pipeline, stage, entered_at, by_name) VALUES (?, ?, ?, ?, ?)", d.id, pipeline, stage, now, who.name);
    return Number(h.lastInsertRowid);
  }

  function moveDeal(who: Actor, id: string, raw: unknown) {
    const d = mustDeal(id);
    mustChange(who, d, "deal");
    const b = body(raw, ["stage", "pipeline"]);
    const pipeline = b.pipeline === undefined ? d.pipeline : String(b.pipeline);
    const stage = mustStage(pipeline, String(b.stage ?? ""));
    if (d.status !== "open") throw new CrmError(409, "conflict", `The deal is ${d.status}; reopen it to move it.`);
    if (d.stage === stage.id && d.pipeline === pipeline) return dealOut(d, who);
    return tx(() => {
      const from = stageOf(d.pipeline, d.stage)?.name ?? d.stage;
      const h = enterStage(d, pipeline, stage.id, who);
      run(
        "UPDATE deals SET pipeline = ?, stage = ?, stage_entered_at = ?, last_activity_at = ?, updated_at = ? WHERE id = ?",
        pipeline,
        stage.id,
        iso(),
        iso(),
        iso(),
        id,
      );
      addActivity({ kind: "system", text: `Moved from ${from} to ${stage.name}`, deal: id, by: who, event: "stage", data: { from, to: stage.name } });
      const after = mustDeal(id);
      toAudience(
        "deal_stage_changed",
        `deal-${id}:stage:${h}`,
        contactRow(after.contact_id),
        { ...dealProps(after), from },
        `Deal ${after.name} moved to ${stage.name}`,
      );
      return dealOut(after, who);
    });
  }

  function closeDeal(who: Actor, id: string, raw: unknown, status: "won" | "lost") {
    const d = mustDeal(id);
    mustChange(who, d, "deal");
    const b = body(raw, ["reason", "note", "value"]);
    if (d.status !== "open") throw new CrmError(409, "conflict", `The deal is ${d.status} already.`);
    const p = pipelineOf(d.pipeline);
    const list = status === "won" ? (p?.wonReasons ?? []) : (p?.lostReasons ?? []);
    let reason = optText(b.reason, "reason", 120) ?? null;
    if (status === "lost" && !reason) throw bad(`reason says why it was lost${list.length ? `: ${list.join(", ")}` : ""}.`);
    if (reason && list.length) {
      const match = list.find((r) => r.toLocaleLowerCase("tr") === reason!.toLocaleLowerCase("tr"));
      if (!match) throw bad(`reason is one of the pipeline's ${status} reasons: ${list.join(", ")}.`);
      reason = match;
    }
    const note = optText(b.note, "note", 2000) ?? null;
    return tx(() => {
      const h = enterStage(d, d.pipeline, status, who);
      const set: Record<string, string | number | null> = { status, reason, reason_note: note, closed_at: iso(), last_activity_at: iso() };
      if (b.value !== undefined) set.value_minor = amount(b.value, "value");
      patch("deals", id, set);
      const after = mustDeal(id);
      const v = formatMoney(after.value_minor, after.currency, "en");
      addActivity({
        kind: "system",
        text: status === "won" ? `Won: ${v}${reason ? ` (${reason})` : ""}` : `Lost: ${reason}${note ? `. ${note}` : ""}`,
        deal: id,
        by: who,
        event: status,
        data: { reason, note, value: money(after.value_minor) },
      });
      const contact = contactRow(after.contact_id);
      toAudience(
        `deal_${status}`,
        `deal-${id}:${status}:${h}`,
        contact,
        { ...dealProps(after), reason },
        `Deal ${after.name} ${status}${reason ? `: ${reason}` : ""}`,
      );
      // A Messages journey whose goal is deal_won or deal_lost lets the person go.
      toMessages(`deal_${status}`, contact, { deal: after.name, company: companyName(after.company_id) ?? "" });
      return dealOut(after, who);
    });
  }

  function reopenDeal(who: Actor, id: string, raw: unknown) {
    const d = mustDeal(id);
    mustChange(who, d, "deal");
    const b = body(raw, ["stage"]);
    if (d.status === "open") throw new CrmError(409, "conflict", "The deal is open already.");
    const last = one<{ stage: string }>("SELECT stage FROM stage_history WHERE deal_id = ? AND stage NOT IN ('won', 'lost') ORDER BY id DESC LIMIT 1", id);
    const stage = mustStage(d.pipeline, b.stage === undefined ? (last?.stage ?? pipelineOf(d.pipeline)?.stages[0]?.id ?? "") : String(b.stage));
    return tx(() => {
      enterStage(d, d.pipeline, stage.id, who);
      run(
        "UPDATE deals SET status = 'open', stage = ?, reason = NULL, reason_note = NULL, closed_at = NULL, stage_entered_at = ?, last_activity_at = ?, updated_at = ? WHERE id = ?",
        stage.id,
        iso(),
        iso(),
        iso(),
        id,
      );
      addActivity({ kind: "system", text: `Reopened in ${stage.name}`, deal: id, by: who, event: "reopened", data: { to: stage.name } });
      return dealOut(mustDeal(id), who);
    });
  }

  function removeDeal(who: Actor, id: string) {
    const d = mustDeal(id);
    mustChange(who, d, "deal");
    run("DELETE FROM deals WHERE id = ?", id);
  }

  function getDeal(who: Actor, id: string) {
    const d = mustDeal(id);
    const history = q<{ pipeline: string; stage: string; entered_at: string; left_at: string | null; by_name: string | null }>(
      "SELECT pipeline, stage, entered_at, left_at, by_name FROM stage_history WHERE deal_id = ? ORDER BY id",
      id,
    );
    // Time in each stage, summed when a deal went back to one.
    const days = new Map<string, number>();
    for (const h of history) days.set(h.stage, (days.get(h.stage) ?? 0) + ((h.left_at ? Date.parse(h.left_at) : clock()) - Date.parse(h.entered_at)) / DAY);
    const company = d.company_id ? one<CompanyRow>("SELECT * FROM companies WHERE id = ?", d.company_id) : undefined;
    const contact = contactRow(d.contact_id);
    return {
      ...dealOut(d, who),
      companyDetail: company ? companyOut(company, who) : null,
      contactDetail: contact ? contactOut(contact, who) : null,
      history: history.map((h) => ({
        stage: h.stage,
        name: stageOf(h.pipeline, h.stage)?.name ?? (h.stage === "won" ? "Won" : h.stage === "lost" ? "Lost" : h.stage),
        enteredAt: h.entered_at,
        leftAt: h.left_at,
        by: h.by_name,
      })),
      timeInStage: [...days].map(([stage, n]) => ({ stage, days: Math.round(n * 10) / 10 })),
      activities: listActivities({ deal: id }),
      tasks: q<TaskRow>("SELECT * FROM tasks WHERE deal_id = ? ORDER BY done_at IS NOT NULL, due_date, created_at", id).map(taskOut),
      quotes: q<QuoteRow>("SELECT * FROM quotes WHERE deal_id = ? ORDER BY created_at DESC", id).map(quoteOut),
      sequences: config?.messages?.sequences.map((s) => ({ id: s.id, name: s.name })) ?? [],
      lostReasons: pipelineOf(d.pipeline)?.lostReasons ?? [],
      wonReasons: pipelineOf(d.pipeline)?.wonReasons ?? [],
    };
  }

  // ------------------------------------------------------------------ tasks

  /** The morning of the due day at tasks.remind_at, in the file's zone; null when that is past already. */
  function remindAtFor(day: string): string | null {
    const [y, m, d] = day.split("-").map(Number);
    const at = fromWallClock(y!, m!, d!, cfg().tasks.remindAt, cfg().timeZone);
    return at > clock() ? iso(at) : null;
  }

  function listTasks(who: Actor, query: URLSearchParams) {
    const owner = query.get("owner") ?? "me";
    const state = query.get("state") ?? "open";
    if (!["open", "done", "all"].includes(state)) throw bad("state is open, done or all.");
    return q<TaskRow>(
      `SELECT * FROM tasks WHERE (? = 'all' OR (? = 'open' AND done_at IS NULL) OR (? = 'done' AND done_at IS NOT NULL)) ORDER BY done_at IS NOT NULL, due_date, due_time, created_at LIMIT 1000`,
      state,
      state,
      state,
    )
      .filter((t) => owner === "all" || (owner === "me" ? t.owner_id === who.id : t.owner_id === owner))
      .map(taskOut);
  }

  function createTask(who: Actor, raw: unknown) {
    const b = body(raw, ["text", "due", "time", "deal", "contact", "owner", "remind"]);
    const t = text(b.text, "text", 300);
    const due = optDay(b.due, "due");
    if (!due) throw bad("due is a day, YYYY-MM-DD.");
    const time = b.time === undefined || b.time === null || b.time === "" ? null : String(b.time);
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw bad("time is a time such as 14:30.");
    const deal = b.deal === undefined || b.deal === null ? undefined : mustDeal(String(b.deal));
    const contact = b.contact === undefined || b.contact === null ? undefined : mustContact(String(b.contact));
    if (deal) mustChange(who, deal, "deal");
    else if (contact) mustChange(who, contact, "contact");
    let owner = b.owner === undefined ? (selfOwner(who) ?? ownerOut(deal?.owner_id ?? null, deal?.owner_name ?? null)) : ownerFrom(b.owner);
    if (owner && owner.id !== who.id && !atLeast(who.role, "admin") && !(deal && deal.owner_id === who.id))
      throw new CrmError(403, "forbidden", "Editors give tasks to others only on their own deals.");
    owner = owner ?? null;
    if (b.remind !== undefined && typeof b.remind !== "boolean") throw bad("remind is true or false.");
    return tx(() => {
      const id = randomUUID();
      run(
        "INSERT INTO tasks (id, text, deal_id, contact_id, owner_id, owner_name, due_date, due_time, remind_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        t,
        deal?.id ?? null,
        contact?.id ?? deal?.contact_id ?? null,
        owner?.id ?? null,
        owner?.name ?? null,
        due,
        time,
        b.remind === false ? null : remindAtFor(due),
        iso(),
        who.name,
      );
      return taskOut(one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id)!);
    });
  }

  function mustTaskChange(who: Actor, t: TaskRow) {
    if (t.owner_id === who.id || atLeast(who.role, "admin")) return;
    const deal = t.deal_id ? one<DealRow>("SELECT * FROM deals WHERE id = ?", t.deal_id) : undefined;
    if (atLeast(who.role, "editor") && (t.owner_id === null || (deal && deal.owner_id === who.id))) return;
    throw new CrmError(403, "forbidden", `This task is ${t.owner_name ?? "someone else"}'s; only its owner, the deal's owner or an admin changes it.`);
  }

  function updateTask(who: Actor, id: string, raw: unknown) {
    const t = one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
    if (!t) throw notFound("The task");
    mustTaskChange(who, t);
    const b = body(raw, ["text", "due", "time", "owner", "done"]);
    return tx(() => {
      const set: Record<string, string | number | null> = {};
      if (b.text !== undefined) set.text = text(b.text, "text", 300);
      const due = optDay(b.due, "due");
      if (due === null) throw bad("due is a day, YYYY-MM-DD.");
      if (due !== undefined && due !== t.due_date) Object.assign(set, { due_date: due, remind_at: remindAtFor(due), reminded_at: null });
      if (b.time !== undefined) {
        if (b.time !== null && b.time !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time))) throw bad("time is a time such as 14:30.");
        set.due_time = b.time === null || b.time === "" ? null : String(b.time);
      }
      const owner = ownerFrom(b.owner);
      if (owner !== undefined) Object.assign(set, { owner_id: owner?.id ?? null, owner_name: owner?.name ?? null });
      if (b.done !== undefined) {
        if (typeof b.done !== "boolean") throw bad("done is true or false.");
        if (b.done && !t.done_at) {
          Object.assign(set, { done_at: iso(), done_by: who.name });
          if (t.deal_id)
            addActivity({
              kind: "system",
              text: `Task done: ${t.text}`,
              deal: t.deal_id,
              contact: t.contact_id,
              by: who,
              event: "task-done",
              data: { task: t.text },
            });
        } else if (!b.done && t.done_at) Object.assign(set, { done_at: null, done_by: null });
      }
      patch("tasks", id, set);
      return taskOut(one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id)!);
    });
  }

  function removeTask(who: Actor, id: string) {
    const t = one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
    if (!t) throw notFound("The task");
    mustTaskChange(who, t);
    run("DELETE FROM tasks WHERE id = ?", id);
  }

  /** Each owner's reminders that are due, in one email a round, with their stale deals. */
  async function remind() {
    const c = config;
    if (!c) return;
    const due = q<TaskRow>("SELECT * FROM tasks WHERE remind_at <= ? AND reminded_at IS NULL AND done_at IS NULL ORDER BY owner_id, due_date", iso());
    if (!due.length) return;
    const byOwner = new Map<string, TaskRow[]>();
    for (const t of due) byOwner.set(t.owner_id ?? "", [...(byOwner.get(t.owner_id ?? "") ?? []), t]);
    for (const [ownerId, tasks] of byOwner) {
      const to = memberEmail(ownerId || null);
      // A reminder older than half a day is not sent late; it shows in the app.
      const late = tasks.every((t) => clock() - Date.parse(t.remind_at!) > 12 * 3_600_000);
      const done = () => tx(() => tasks.forEach((t) => run("UPDATE tasks SET reminded_at = ? WHERE id = ?", iso(), t.id)));
      if (!to || !mailer || late) {
        done();
        count(counters.reminders, !to || !mailer ? "in-app" : "late");
        continue;
      }
      const stale = q<DealRow>("SELECT * FROM deals WHERE status = 'open' AND owner_id = ?", ownerId).filter(isStale);
      const lines = tasks.map((t) => {
        const deal = t.deal_id ? one<DealRow>("SELECT * FROM deals WHERE id = ?", t.deal_id) : undefined;
        return `- ${t.text}${t.due_time ? ` (${t.due_time})` : ""}${deal ? `, ${companyName(deal.company_id) ?? ""}${companyName(deal.company_id) ? ": " : ""}${deal.name}` : ""}\n  ${opts.publicUrl}/tasks`;
      });
      const staleLines = stale.map(
        (d) =>
          `- ${companyName(d.company_id) ? `${companyName(d.company_id)}: ` : ""}${d.name}, ${quietDays(d)} days without activity\n  ${opts.publicUrl}/deals/${d.id}`,
      );
      try {
        await mailer.send({
          to,
          subject: tasks.length === 1 ? `Due today: ${tasks[0]!.text}` : `${tasks.length} tasks due today`,
          text: [
            `Your tasks due today in CRM:`,
            "",
            ...lines,
            ...(staleLines.length ? ["", "Deals with no activity for longer than their stage allows:", "", ...staleLines] : []),
            "",
            `${opts.publicUrl}/tasks`,
          ].join("\n"),
        });
        linkOk("mail");
        count(counters.reminders, "sent");
        done();
      } catch (err) {
        linkFailed("mail", err);
        count(counters.reminders, "failed");
        log("warn", "task reminder not sent yet: will try again", { error: String(err), tasks: tasks.length });
      }
    }
  }

  // ------------------------------------------------------------------ quotes

  function linesOf(quote: string) {
    return q<LineRow>("SELECT pos, item, quantity, unit_minor, discount FROM quote_lines WHERE quote_id = ? ORDER BY pos", quote);
  }
  const lineTotal = (l: LineRow) => Math.round(l.quantity * l.unit_minor * (1 - l.discount / 100));
  function totals(lines: LineRow[], vat: number) {
    const subtotal = lines.reduce((n, l) => n + lineTotal(l), 0);
    const vatMinor = Math.round((subtotal * vat) / 100);
    return { subtotal, vat: vatMinor, total: subtotal + vatMinor };
  }

  function quoteOut(r: QuoteRow) {
    const lines = linesOf(r.id);
    const t = totals(lines, r.vat);
    return {
      id: r.id,
      number: r.number,
      deal: r.deal_id,
      state: r.state,
      currency: r.currency,
      vat: r.vat,
      validUntil: r.valid_until,
      notes: r.notes,
      lines: lines.map((l) => ({ item: l.item, quantity: l.quantity, unitPrice: money(l.unit_minor), discount: l.discount, total: money(lineTotal(l)) })),
      subtotal: money(t.subtotal),
      vatAmount: money(t.vat),
      total: money(t.total),
      createdAt: r.created_at,
      createdBy: r.created_by,
      sentAt: r.sent_at,
      decidedAt: r.decided_at,
      pdf: `/api/v1/quotes/${r.id}/pdf`,
    };
  }

  function linesFrom(v: unknown): LineRow[] {
    if (!Array.isArray(v) || v.length < 1 || v.length > 100) throw bad("lines is a list of 1 to 100 lines, each { item, quantity, unitPrice, discount }.");
    return v.map((l, i) => {
      if (!isObj(l)) throw bad(`lines[${i}] is { item, quantity, unitPrice, discount }.`);
      const extra = Object.keys(l).filter((k) => !["item", "quantity", "unitPrice", "discount"].includes(k));
      if (extra.length) throw bad(`lines[${i}]: unknown ${extra.join(", ")}.`);
      const quantity = l.quantity === undefined ? 1 : Number(l.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1e6 || Math.round(quantity * 1000) !== quantity * 1000)
        throw bad(`lines[${i}].quantity is more than 0, with at most three decimals.`);
      const discount = l.discount === undefined || l.discount === null ? 0 : Number(l.discount);
      if (!Number.isFinite(discount) || discount < 0 || discount > 100) throw bad(`lines[${i}].discount is a share from 0 to 100.`);
      return { pos: i, item: text(l.item, `lines[${i}].item`, 300), quantity, unit_minor: amount(l.unitPrice, `lines[${i}].unitPrice`), discount };
    });
  }

  function saveLines(quote: string, lines: LineRow[]) {
    run("DELETE FROM quote_lines WHERE quote_id = ?", quote);
    for (const l of lines)
      run(
        "INSERT INTO quote_lines (quote_id, pos, item, quantity, unit_minor, discount) VALUES (?, ?, ?, ?, ?, ?)",
        quote,
        l.pos,
        l.item,
        l.quantity,
        l.unit_minor,
        l.discount,
      );
  }

  function createQuote(who: Actor, dealId: string, raw: unknown) {
    const d = mustDeal(dealId);
    mustChange(who, d, "deal");
    const b = body(raw ?? {}, ["lines", "notes", "validUntil"]);
    const c = cfg();
    return tx(() => {
      // A new quote starts from the deal's last quote, or one line with the deal's name and value.
      const last = one<{ id: string }>("SELECT id FROM quotes WHERE deal_id = ? ORDER BY created_at DESC LIMIT 1", dealId);
      const lines =
        b.lines !== undefined ? linesFrom(b.lines) : last ? linesOf(last.id) : [{ pos: 0, item: d.name, quantity: 1, unit_minor: d.value_minor, discount: 0 }];
      const year = Number(today().slice(0, 4));
      run("INSERT INTO quote_numbers (year, last) VALUES (?, 1) ON CONFLICT (year) DO UPDATE SET last = last + 1", year);
      const n = one<{ last: number }>("SELECT last FROM quote_numbers WHERE year = ?", year)!.last;
      const id = randomUUID();
      const valid = optDay(b.validUntil, "validUntil") ?? new Date(Date.parse(`${today()}T00:00:00Z`) + c.quotes.validDays * DAY).toISOString().slice(0, 10);
      run(
        "INSERT INTO quotes (id, number, deal_id, state, currency, vat, valid_until, notes, seller, created_at, created_by) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)",
        id,
        `Q-${year}-${String(n).padStart(3, "0")}`,
        dealId,
        d.currency,
        c.quotes.vat,
        valid,
        optText(b.notes, "notes", 2000) ?? null,
        JSON.stringify({ ...c.quotes.seller, terms: c.quotes.terms, language: c.quotes.language }),
        iso(),
        who.name,
      );
      saveLines(id, lines);
      run("UPDATE deals SET last_activity_at = ? WHERE id = ?", iso(), dealId);
      return quoteOut(one<QuoteRow>("SELECT * FROM quotes WHERE id = ?", id)!);
    });
  }

  function mustQuote(id: string) {
    const r = one<QuoteRow>("SELECT * FROM quotes WHERE id = ?", id);
    if (!r) throw notFound("The quote");
    return { r, deal: mustDeal(r.deal_id) };
  }

  function updateQuote(who: Actor, id: string, raw: unknown) {
    const { r, deal } = mustQuote(id);
    mustChange(who, deal, "deal");
    if (r.state !== "draft") throw new CrmError(409, "conflict", `Quote ${r.number} is ${r.state}; a sent quote stays as it was sent. Make a new one.`);
    const b = body(raw, ["lines", "notes", "validUntil"]);
    return tx(() => {
      if (b.lines !== undefined) saveLines(id, linesFrom(b.lines));
      const notes = optText(b.notes, "notes", 2000);
      if (notes !== undefined) run("UPDATE quotes SET notes = ? WHERE id = ?", notes, id);
      const valid = optDay(b.validUntil, "validUntil");
      if (valid) run("UPDATE quotes SET valid_until = ? WHERE id = ?", valid, id);
      return quoteOut(one<QuoteRow>("SELECT * FROM quotes WHERE id = ?", id)!);
    });
  }

  function removeQuote(who: Actor, id: string) {
    const { r, deal } = mustQuote(id);
    mustChange(who, deal, "deal");
    if (r.state !== "draft") throw new CrmError(409, "conflict", `Quote ${r.number} was sent; it stays in the deal's history.`);
    run("DELETE FROM quotes WHERE id = ?", id);
  }

  async function quoteFile(id: string): Promise<{ filename: string; pdf: Buffer }> {
    const { r, deal } = mustQuote(id);
    const seller = JSON.parse(r.seller) as Config["quotes"]["seller"] & { terms: string | null; language: "en" | "tr" | "de" };
    const lines = linesOf(id);
    const t = totals(lines, r.vat);
    const contact = contactRow(deal.contact_id);
    const pdf = await quotePdf({
      number: r.number,
      date: r.created_at.slice(0, 10),
      validUntil: r.valid_until,
      currency: r.currency,
      vat: r.vat,
      language: seller.language,
      seller,
      buyer: { company: companyName(deal.company_id), contact: contact?.name ?? null, email: contact?.email ?? null },
      deal: deal.name,
      lines: lines.map((l) => ({ item: l.item, quantity: l.quantity, unitMinor: l.unit_minor, discount: l.discount, totalMinor: lineTotal(l) })),
      subtotalMinor: t.subtotal,
      vatMinor: t.vat,
      totalMinor: t.total,
      notes: r.notes,
      terms: seller.terms,
      by: r.created_by,
    });
    return { filename: `${r.number}.pdf`, pdf };
  }

  async function sendQuote(who: Actor, id: string, raw: unknown) {
    const { r, deal } = mustQuote(id);
    mustChange(who, deal, "deal");
    const b = body(raw ?? {}, ["email", "to", "message"]);
    if (r.state !== "draft") throw new CrmError(409, "conflict", `Quote ${r.number} is ${r.state} already.`);
    if (b.email !== undefined && typeof b.email !== "boolean") throw bad("email is true to send the PDF by email, false to mark it sent.");
    const t = totals(linesOf(id), r.vat);
    let to: string | null = null;
    if (b.email) {
      if (!mailer) throw new CrmError(409, "not-linked", "No mail server in the settings file; download the PDF and send it yourself, then mark it sent.");
      to = optEmail(b.to, "to") ?? contactRow(deal.contact_id)?.email ?? null;
      if (!to) throw bad("to is the address to send it to; the deal's contact has no email.");
      const file = await quoteFile(id);
      const message = optText(b.message, "message", 5000);
      try {
        await mailer.send({
          to,
          subject: `${r.number}: ${deal.name}`,
          text: message ?? `Please find quote ${r.number} attached.\n\n${who.name}`,
          attachments: [{ filename: file.filename, content: file.pdf, contentType: "application/pdf" }],
        });
        linkOk("mail");
      } catch (err) {
        linkFailed("mail", err);
        throw new CrmError(502, "link-failed", `The mail server did not take the quote: ${(err as Error).message}`);
      }
    }
    return tx(() => {
      run("UPDATE quotes SET state = 'sent', sent_at = ? WHERE id = ?", iso(), id);
      // The deal is worth what was quoted, without KDV.
      if (deal.status === "open") run("UPDATE deals SET value_minor = ?, updated_at = ? WHERE id = ?", t.subtotal, iso(), deal.id);
      addActivity({
        kind: to ? "email" : "system",
        text: to ? `Sent quote ${r.number} as PDF to ${to}` : `Quote ${r.number} marked sent`,
        deal: deal.id,
        contact: deal.contact_id,
        by: who,
        event: "quote-sent",
        data: { quote: r.number, to, total: money(t.subtotal) },
      });
      return quoteOut(one<QuoteRow>("SELECT * FROM quotes WHERE id = ?", id)!);
    });
  }

  function decideQuote(who: Actor, id: string, state: "accepted" | "declined") {
    const { r, deal } = mustQuote(id);
    mustChange(who, deal, "deal");
    if (r.state !== "sent")
      throw new CrmError(409, "conflict", r.state === "draft" ? `Quote ${r.number} is not sent yet.` : `Quote ${r.number} is ${r.state} already.`);
    return tx(() => {
      run("UPDATE quotes SET state = ?, decided_at = ? WHERE id = ?", state, iso(), id);
      addActivity({ kind: "system", text: `Quote ${r.number} ${state}`, deal: deal.id, by: who, event: `quote-${state}`, data: { quote: r.number } });
      // An accepted quote wins the deal, at the quote's value without KDV.
      if (state === "accepted" && deal.status === "open") closeDeal(who, deal.id, { value: money(totals(linesOf(id), r.vat).subtotal) }, "won");
      return quoteOut(one<QuoteRow>("SELECT * FROM quotes WHERE id = ?", id)!);
    });
  }

  function getQuote(id: string) {
    return quoteOut(mustQuote(id).r);
  }

  // ------------------------------------------------------------------ sequences in Messages

  function startSequence(who: Actor, dealId: string, raw: unknown) {
    const d = mustDeal(dealId);
    mustChange(who, d, "deal");
    const b = body(raw, ["sequence"]);
    const c = cfg();
    if (!c.messages) throw new CrmError(409, "not-linked", "Messages is not linked in the settings file.");
    const s = c.messages.sequences.find((x) => x.id === b.sequence);
    if (!s) throw bad(`sequence is one of the file's sequences: ${c.messages.sequences.map((x) => x.id).join(", ") || "none"}.`);
    const contact = contactRow(d.contact_id);
    if (!contact?.email) throw new CrmError(409, "conflict", "The deal's contact has no email address, so no sequence can reach them.");
    return tx(() => {
      toMessages(s.event, contact, {
        deal: d.name,
        company: companyName(d.company_id) ?? "",
        owner: d.owner_name ?? "",
        stage: stageOf(d.pipeline, d.stage)?.name ?? d.stage,
        first_name: contact.name.split(/\s+/)[0] ?? contact.name,
      });
      addActivity({
        kind: "system",
        text: `Started the sequence ${s.name} in Messages`,
        deal: d.id,
        contact: contact.id,
        by: who,
        event: "sequence",
        data: { sequence: s.name },
      });
      return { sequence: s.id, event: s.event, queued: true };
    });
  }

  // ------------------------------------------------------------------ the forecast and the reports

  function report(who: Actor, query: URLSearchParams) {
    const c = cfg();
    const pipeline = query.get("pipeline") ?? c.pipelines[0]!.id;
    const p = pipelineOf(pipeline);
    if (!p) throw bad(`pipeline is one of ${c.pipelines.map((x) => x.id).join(", ")}.`);
    const owner = query.get("owner");
    const all = q<DealRow>("SELECT * FROM deals WHERE pipeline = ?", pipeline).filter(
      (d) => !owner || (owner === "me" ? d.owner_id === who.id : d.owner_id === owner),
    );
    const now = clock();
    const thisMonth = month(now);
    const open = all.filter((d) => d.status === "open");
    const weighted = (d: DealRow) => Math.round((d.value_minor * probability(d)) / 100);
    const closedWithin = (d: DealRow, from: number, to: number) => !!d.closed_at && Date.parse(d.closed_at) >= from && Date.parse(d.closed_at) < to;

    // The forecast: won deals in the month they were won, open ones at their weighted value in their expected month.
    const months: string[] = [];
    {
      const l = localDate(now, c.timeZone);
      for (let i = 0; i < 6; i++) {
        const m = new Date(Date.UTC(l.year, l.month - 1 + i, 1));
        months.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, "0")}`);
      }
    }
    const forecast = months.map((m) => {
      const won = all.filter((d) => d.status === "won" && forecastMonth(d) === m);
      const expected = open.filter((d) => forecastMonth(d) === m);
      const w = won.reduce((n, d) => n + d.value_minor, 0);
      const e = expected.reduce((n, d) => n + weighted(d), 0);
      return {
        month: m,
        won: money(w),
        weighted: money(e),
        total: money(w + e),
        deals: expected.length,
        overdue: expected.filter((d) => d.expected_close! < `${thisMonth}-01`).length,
      };
    });

    // Won and lost by month, the last six months.
    const history = [];
    {
      const l = localDate(now, c.timeZone);
      for (let i = 5; i >= 0; i--) {
        const m = new Date(Date.UTC(l.year, l.month - 1 - i, 1));
        const key = `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, "0")}`;
        const won = all.filter((d) => d.status === "won" && d.closed_at && month(Date.parse(d.closed_at)) === key);
        const lost = all.filter((d) => d.status === "lost" && d.closed_at && month(Date.parse(d.closed_at)) === key);
        history.push({
          month: key,
          won: money(won.reduce((n, d) => n + d.value_minor, 0)),
          lost: money(lost.reduce((n, d) => n + d.value_minor, 0)),
          wonCount: won.length,
          lostCount: lost.length,
        });
      }
    }

    const rate = (from: number, to: number) => {
      const won = all.filter((d) => d.status === "won" && closedWithin(d, from, to)).length;
      const lost = all.filter((d) => d.status === "lost" && closedWithin(d, from, to)).length;
      return { won, lost, rate: won + lost ? Math.round((won / (won + lost)) * 1000) / 10 : null };
    };
    const last90 = rate(now - 90 * DAY, now + 1);
    const before90 = rate(now - 180 * DAY, now - 90 * DAY);
    const reasons = (status: "won" | "lost") => {
      const m = new Map<string, { count: number; value: number }>();
      for (const d of all.filter((x) => x.status === status && closedWithin(x, now - 90 * DAY, now + 1))) {
        const k = d.reason ?? "";
        const e = m.get(k) ?? { count: 0, value: 0 };
        m.set(k, { count: e.count + 1, value: e.value + d.value_minor });
      }
      return [...m]
        .filter(([k]) => k)
        .sort((a, b) => b[1].count - a[1].count || b[1].value - a[1].value)
        .map(([reason, x]) => ({ reason, count: x.count, value: money(x.value) }));
    };

    // Time in stage: the stays that ended in the last 90 days, in this pipeline's stages.
    const stays = q<{ stage: string; entered_at: string; left_at: string }>(
      "SELECT stage, entered_at, left_at FROM stage_history WHERE pipeline = ? AND left_at >= ? AND stage NOT IN ('won', 'lost')",
      pipeline,
      iso(now - 90 * DAY),
    );
    const stages = p.stages.map((s) => {
      const inStage = open.filter((d) => d.stage === s.id);
      const done = stays.filter((x) => x.stage === s.id);
      const avg = done.length ? done.reduce((n, x) => n + (Date.parse(x.left_at) - Date.parse(x.entered_at)), 0) / done.length / DAY : null;
      return {
        id: s.id,
        name: s.name,
        probability: s.probability,
        staleAfter: s.staleDays,
        open: inStage.length,
        value: money(inStage.reduce((n, d) => n + d.value_minor, 0)),
        weighted: money(inStage.reduce((n, d) => n + weighted(d), 0)),
        stale: inStage.filter(isStale).length,
        avgDays: avg === null ? null : Math.round(avg * 10) / 10,
        left: done.length,
      };
    });

    const owners = new Map<
      string,
      { owner: { id: string; name: string } | null; deals: number; value: number; weighted: number; forecast: number; stale: number; won: number }
    >();
    for (const d of all) {
      const k = d.owner_id ?? "";
      const e = owners.get(k) ?? { owner: ownerOut(d.owner_id, d.owner_name), deals: 0, value: 0, weighted: 0, forecast: 0, stale: 0, won: 0 };
      if (d.status === "open") {
        e.deals++;
        e.value += d.value_minor;
        e.weighted += weighted(d);
        if (isStale(d)) e.stale++;
      }
      if (forecastMonth(d) === thisMonth) e.forecast += d.status === "won" ? d.value_minor : weighted(d);
      if (d.status === "won" && closedWithin(d, now - 90 * DAY, now + 1)) e.won += d.value_minor;
      if (d.status === "open" || e.forecast || e.won) owners.set(k, e);
    }

    const wonMonth = all.filter((d) => d.status === "won" && d.closed_at && month(Date.parse(d.closed_at)) === thisMonth);
    const lostMonth = all.filter((d) => d.status === "lost" && d.closed_at && month(Date.parse(d.closed_at)) === thisMonth);
    return {
      pipeline,
      currency: c.currency,
      month: thisMonth,
      open: { count: open.length, value: money(open.reduce((n, d) => n + d.value_minor, 0)), noCloseDate: open.filter((d) => !d.expected_close).length },
      forecast,
      won: {
        count: wonMonth.length,
        value: money(wonMonth.reduce((n, d) => n + d.value_minor, 0)),
        deals: wonMonth.slice(0, 5).map((d) => ({ id: d.id, name: d.name, company: companyName(d.company_id), value: money(d.value_minor) })),
      },
      lost: {
        count: lostMonth.length,
        value: money(lostMonth.reduce((n, d) => n + d.value_minor, 0)),
        deals: lostMonth
          .slice(0, 5)
          .map((d) => ({ id: d.id, name: d.name, company: companyName(d.company_id), value: money(d.value_minor), reason: d.reason })),
      },
      winRate: { days: 90, ...last90, before: before90.rate },
      stale: open.filter(isStale).length,
      history,
      lostReasons: reasons("lost"),
      wonReasons: reasons("won"),
      stages,
      owners: [...owners.values()]
        .sort((a, b) => b.value - a.value)
        .map((o) => ({ ...o, value: money(o.value), weighted: money(o.weighted), forecast: money(o.forecast), won: money(o.won) })),
    };
  }

  function summary(who: Actor) {
    const c = config;
    const mine = q<TaskRow>("SELECT * FROM tasks WHERE owner_id = ? AND done_at IS NULL", who.id);
    const day = c ? today() : "9999";
    return {
      tasksDue: mine.filter((t) => t.due_date <= day).length,
      tasksOpen: mine.length,
      stale: c ? q<DealRow>("SELECT * FROM deals WHERE status = 'open' AND owner_id = ?", who.id).filter(isStale).length : 0,
      file: opts.fileState?.() ?? null,
    };
  }

  // ------------------------------------------------------------------ CSV import

  const ALIASES: Record<string, string[]> = {
    name: ["name", "ad", "isim", "ad_soyad", "full_name", "deal", "deal_name", "company_name"],
    email: ["email", "e-mail", "e-posta", "eposta", "mail", "contact_email"],
    phone: ["phone", "telefon", "tel", "mobile", "gsm"],
    title: ["title", "unvan", "ünvan", "job_title", "position"],
    company: ["company", "firma", "şirket", "sirket", "organization", "account"],
    domain: ["domain", "website", "web"],
    sector: ["sector", "sektör", "sektor", "industry"],
    city: ["city", "şehir", "sehir", "il"],
    plan: ["plan", "paket"],
    plan_renews: ["plan_renews", "renews", "renewal", "yenileme"],
    users: ["users", "seats", "kullanıcı", "kullanici"],
    owner: ["owner", "owner_email", "sahip", "sorumlu"],
    value: ["value", "amount", "tutar", "değer", "deger"],
    stage: ["stage", "aşama", "asama"],
    pipeline: ["pipeline"],
    expected_close: ["expected_close", "close", "close_date", "kapanış", "kapanis"],
    status: ["status", "durum"],
    reason: ["reason", "lost_reason", "neden"],
    contact_name: ["contact_name", "contact", "kişi", "kisi"],
    external_id: ["external_id", "id"],
  };
  const KIND_COLUMNS: Record<string, string[]> = {
    companies: ["name", "domain", "sector", "city", "plan", "plan_renews", "users", "owner", "external_id"],
    contacts: ["name", "email", "phone", "title", "company", "owner", "external_id"],
    deals: ["name", "value", "stage", "pipeline", "company", "email", "contact_name", "owner", "expected_close", "status", "reason", "external_id"],
  };

  function importCsv(who: Actor, raw: unknown) {
    const b = body(raw, ["kind", "csv", "dryRun"]);
    const kind = String(b.kind ?? "");
    if (!KIND_COLUMNS[kind]) throw bad("kind is companies, contacts or deals.");
    if (typeof b.csv !== "string" || !b.csv.trim()) throw bad("csv is the file's text, with a header line.");
    if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") throw bad("dryRun is true or false.");
    const rows = parseCsv(b.csv);
    if (rows.length < 2) throw bad("csv has a header line and at least one row.");
    if (rows.length > 5001) throw bad("csv holds at most 5000 rows; split it.");
    const header = rows[0]!.map((h) => h.trim().toLocaleLowerCase("tr").replace(/\s+/g, "_"));
    const cols = new Map<string, number>();
    header.forEach((h, i) => {
      for (const [key, names] of Object.entries(ALIASES)) {
        const k = kind === "deals" && key === "name" && h === "company_name" ? "company" : key;
        if (names.includes(h) && KIND_COLUMNS[kind]!.includes(k) && !cols.has(k)) cols.set(k, i);
      }
    });
    if (!cols.has("name")) throw bad(`The header has no name column; ${kind} take ${KIND_COLUMNS[kind]!.join(", ")}.`);
    const ignored = header.filter((_h, i) => ![...cols.values()].includes(i));
    const result = {
      kind,
      rows: rows.length - 1,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [] as Array<{ row: number; message: string }>,
      ignoredColumns: ignored,
      dryRun: b.dryRun === true,
    };
    const DRY = Symbol("dry run");
    try {
      tx(() => {
        rows.slice(1).forEach((r, i) => {
          const row = i + 2;
          const get = (k: string) => {
            const at = cols.get(k);
            return at === undefined ? "" : (r[at] ?? "").trim();
          };
          try {
            const owner = get("owner") ? ownerFrom(get("owner")) : selfOwner(who);
            if (kind === "companies") importCompany(who, get, owner ?? null, result);
            else if (kind === "contacts") importContact(who, get, owner ?? null, result);
            else importDeal(who, get, owner ?? null, result);
          } catch (err) {
            if (!(err instanceof CrmError)) throw err;
            result.errors.push({ row, message: err.message });
            result.skipped++;
          }
        });
        if (result.dryRun) throw DRY;
      });
    } catch (err) {
      if (err !== DRY) throw err;
    }
    return result;
  }

  type Get = (k: string) => string;
  type Result = { created: number; updated: number; skipped: number };

  function importCompany(who: Actor, get: Get, owner: { id: string; name: string } | null, r: Result) {
    const values = companyValues({
      name: get("name"),
      domain: get("domain") || undefined,
      sector: get("sector") || undefined,
      city: get("city") || undefined,
      plan: get("plan") || undefined,
      planRenews: get("plan_renews") ? (parseDay(get("plan_renews")) ?? get("plan_renews")) : undefined,
      users: get("users") || undefined,
    });
    const found =
      (get("external_id") && one<CompanyRow>("SELECT * FROM companies WHERE external_id = ?", get("external_id"))) ||
      one<CompanyRow>("SELECT * FROM companies WHERE name = ? COLLATE NOCASE", values.name!) ||
      (values.domain ? one<CompanyRow>("SELECT * FROM companies WHERE domain = ?", values.domain) : undefined);
    if (found) {
      mustChange(who, found, "company");
      const set: Record<string, string | number | null> = {};
      for (const [k, x] of Object.entries(values)) if (x !== undefined && x !== null) set[k] = x;
      patch("companies", found.id, set);
      r.updated++;
      return;
    }
    const id = randomUUID();
    run(
      "INSERT INTO companies (id, name, domain, sector, city, plan, plan_renews, users, owner_id, owner_name, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      values.name!,
      values.domain ?? null,
      values.sector ?? null,
      values.city ?? null,
      values.plan ?? null,
      values.plan_renews ?? null,
      values.users ?? null,
      owner?.id ?? null,
      owner?.name ?? null,
      get("external_id") || null,
      iso(),
      iso(),
    );
    r.created++;
  }

  function importContact(who: Actor, get: Get, owner: { id: string; name: string } | null, r: Result) {
    const v = contactValues({ name: get("name"), email: get("email") || undefined, phone: get("phone") || undefined, title: get("title") || undefined });
    const company = get("company") ? companyByName(get("company"), owner) : null;
    const found = v.email
      ? one<ContactRow>("SELECT * FROM contacts WHERE email = ?", v.email)
      : get("external_id")
        ? one<ContactRow>("SELECT * FROM contacts WHERE external_id = ?", get("external_id"))
        : undefined;
    if (found) {
      mustChange(who, found, "contact");
      const set: Record<string, string | number | null> = { name: v.name! };
      if (v.phone) set.phone = v.phone;
      if (v.title) set.title = v.title;
      if (company) set.company_id = company;
      patch("contacts", found.id, set);
      r.updated++;
      return;
    }
    const id = insertContact({ name: v.name!, email: v.email ?? null, phone: v.phone ?? null, title: v.title ?? null, company, owner, source: "import" });
    if (get("external_id")) run("UPDATE contacts SET external_id = ? WHERE id = ?", get("external_id"), id);
    r.created++;
  }

  function importDeal(who: Actor, get: Get, owner: { id: string; name: string } | null, r: Result) {
    const c = cfg();
    const pipeline = get("pipeline")
      ? (c.pipelines.find((p) => p.id === get("pipeline") || p.name.toLowerCase() === get("pipeline").toLowerCase())?.id ?? get("pipeline"))
      : c.pipelines[0]!.id;
    const p = pipelineOf(pipeline);
    const stageIn = get("stage");
    const stage = stageIn
      ? (p?.stages.find((s) => s.id === stageIn || s.name.toLocaleLowerCase("tr") === stageIn.toLocaleLowerCase("tr"))?.id ?? stageIn)
      : (p?.stages[0]?.id ?? "");
    const status = (get("status") || "open").toLowerCase();
    if (!["open", "won", "lost"].includes(status)) throw bad("status is open, won or lost.");
    if (status === "open") mustStage(pipeline, stage);
    else if (!p) throw bad(`pipeline: ${pipeline} is not in the settings file.`);
    const value = get("value") ? parseAmount(get("value")) : 0;
    if (value === null || value < 0) throw bad(`value: ${get("value")} is not an amount.`);
    const close = get("expected_close") ? parseDay(get("expected_close")) : null;
    if (get("expected_close") && !close) throw bad(`expected_close: ${get("expected_close")} is not a day, such as 2026-11-28 or 28.11.2026.`);
    if (get("external_id") && one("SELECT id FROM deals WHERE external_id = ?", get("external_id"))) {
      r.skipped++;
      return;
    }
    const company = get("company") ? companyByName(get("company"), owner) : null;
    let contact: string | null = null;
    const email = optEmail(get("email") || undefined);
    if (email) contact = one<{ id: string }>("SELECT id FROM contacts WHERE email = ?", email)?.id ?? null;
    if (!contact && (email || get("contact_name")))
      contact = insertContact({ name: get("contact_name") || email!, email: email ?? null, phone: null, title: null, company, owner, source: "import" });
    const id = insertDeal({
      name: text(get("name"), "name", 200),
      pipeline,
      stage: status === "open" ? stage : (p!.stages.find((s) => s.id === stage)?.id ?? p!.stages.at(-1)!.id),
      valueMinor: value,
      company,
      contact,
      owner,
      expectedClose: close,
      source: "import",
      externalId: get("external_id") || null,
      by: who.name,
    });
    if (status !== "open") {
      const d = mustDeal(id);
      enterStage(d, pipeline, status, who);
      const reason = get("reason") || null;
      run("UPDATE deals SET status = ?, reason = ?, closed_at = ? WHERE id = ?", status, reason, close ? `${close}T12:00:00.000Z` : iso(), id);
    }
    r.created++;
  }

  // ------------------------------------------------------------------ Helpdesk: the customer by email

  /** GET /api/v1/lookup?email=: the contact with exactly this address and their deals, as Helpdesk's CrmLookup takes it. */
  function lookup(raw: string | null) {
    const email = optEmail(raw ?? "", "email");
    if (!email) throw bad("email is the address to look up.");
    const c = one<ContactRow>("SELECT * FROM contacts WHERE email = ?", email);
    if (!c) throw notFound("A contact with that email");
    const company = c.company_id ? one<CompanyRow>("SELECT * FROM companies WHERE id = ?", c.company_id) : undefined;
    const plan = company?.plan ? (cfg().plans.find((p) => p.id === company.plan) ?? { id: company.plan, name: company.plan }) : null;
    const deals = q<DealRow>(
      "SELECT * FROM deals WHERE contact_id = ? OR (company_id IS NOT NULL AND company_id = ?) ORDER BY status = 'open' DESC, updated_at DESC LIMIT 20",
      c.id,
      c.company_id,
    );
    return {
      contact: {
        id: c.id,
        name: c.name,
        email,
        title: c.title,
        company: company ? { name: company.name, users: company.users } : null,
        plan: plan ? { id: plan.id, name: plan.name, renews: company?.plan_renews ?? null } : null,
        owner: c.owner_id ? { name: c.owner_name ?? "", email: memberEmail(c.owner_id) } : null,
        url: `${opts.publicUrl}/contacts/${c.id}`,
      },
      deals: deals.map((d) => ({
        id: d.id,
        name: d.name,
        amount: money(d.value_minor),
        currency: d.currency,
        stage: d.status === "open" ? (stageOf(d.pipeline, d.stage)?.name ?? d.stage) : d.status === "won" ? "Won" : "Lost",
        status: d.status,
        url: `${opts.publicUrl}/deals/${d.id}`,
      })),
    };
  }

  // ------------------------------------------------------------------ leads from Live Chat, forms and the API

  /**
   * POST /api/v1/leads: a deal in the file's leads.stage, with its contact found or made by email. The same
   * external_id opens one lead however often it is sent: 201 the first time, 200 with the same lead after.
   */
  function openLead(who: Actor, raw: unknown): { status: 200 | 201; body: { lead: { id: string; url: string; contact: string | null; created: boolean } } } {
    const b = body(raw, [
      "external_id",
      "source",
      "name",
      "email",
      "phone",
      "company",
      "page",
      "title",
      "value",
      "owner",
      "referrer",
      "utm",
      "pages",
      "transcript",
      "chat_url",
      "message",
    ]);
    const externalId = text(b.external_id, "external_id", 200);
    const source = b.source === undefined ? "api" : String(b.source);
    if (!/^[a-z0-9-]{1,32}$/.test(source)) throw bad("source is a short id such as live-chat, forms or api.");
    const c = cfg();
    const existing = one<DealRow>("SELECT * FROM deals WHERE external_id = ?", externalId);
    const answer = (d: DealRow, created: boolean) => ({ lead: { id: d.id, url: `${opts.publicUrl}/deals/${d.id}`, contact: d.contact_id, created } });
    if (existing) return { status: 200, body: answer(existing, false) };
    const name = optText(b.name, "name", 120) ?? null;
    const email = optEmail(b.email) ?? null;
    const phone = optText(b.phone, "phone", 40) ?? null;
    const title = (optText(b.title, "title", 500) ?? `Lead from ${SOURCES[source] ?? source}`).split("\n")[0]!.slice(0, 120);
    const companyIn = optText(b.company, "company", 120) ?? null;
    const valueMinor = b.value === undefined || b.value === null ? 0 : amount(b.value, "value");
    let ownerIn: { name?: unknown; email?: unknown } | null = null;
    if (b.owner !== undefined && b.owner !== null) {
      if (!isObj(b.owner)) throw bad("owner is { name, email }: the member who opened the lead.");
      ownerIn = b.owner;
    }
    const utm = isObj(b.utm) ? b.utm : null;
    const pages = Array.isArray(b.pages) ? b.pages.filter(isObj).slice(-50) : [];
    const transcript = Array.isArray(b.transcript) ? b.transcript.filter(isObj).slice(0, 500) : [];
    const page = optText(b.page, "page", 2000) ?? null;
    const chatUrl = optText(b.chat_url, "chat_url", 2000) ?? null;
    const referrer = optText(b.referrer, "referrer", 2000) ?? null;
    const message = optText(b.message, "message", 5000) ?? null;
    // The member the sender names owns it, else the file's leads.owner, else nobody until someone takes it.
    const m = memberByEmail(typeof ownerIn?.email === "string" ? ownerIn.email : null) ?? memberByEmail(c.leads.owner);
    const owner = m ? { id: m.id, name: m.name } : null;
    return tx(() => {
      let contact = email ? one<ContactRow>("SELECT * FROM contacts WHERE email = ?", email) : undefined;
      const company = companyIn ? companyByName(companyIn, owner) : (contact?.company_id ?? null);
      if (!contact && (email || name || phone)) {
        const id = insertContact({ name: name ?? email ?? phone!, email, phone, title: null, company, owner, source });
        contact = mustContact(id);
      }
      const id = insertDeal({
        name: title,
        pipeline: c.leads.pipeline,
        stage: c.leads.stage,
        valueMinor,
        company,
        contact: contact?.id ?? null,
        owner,
        expectedClose: null,
        source,
        sourceDetail: (typeof utm?.campaign === "string" && utm.campaign) || referrer || page,
        externalId,
        by: typeof ownerIn?.name === "string" ? ownerIn.name : who.name,
      });
      const by = { id: null, name: typeof ownerIn?.name === "string" ? ownerIn.name.slice(0, 120) : who.name };
      const lines = transcript.map((l) => `${String(l.name ?? l.from ?? "")} (${String(l.at ?? "")}): ${String(l.text ?? "")}`);
      const read = pages.map((p) => String(p.path ?? "")).filter(Boolean);
      const parts = [
        message,
        page && `Started on ${page}`,
        referrer && `Came from ${referrer}`,
        utm && [utm.source, utm.medium, utm.campaign].some(Boolean) && `Campaign: ${[utm.source, utm.medium, utm.campaign].filter(Boolean).join(" / ")}`,
        read.length ? `Read: ${read.join(", ")}` : null,
        lines.length ? `\n${lines.join("\n")}` : null,
      ].filter(Boolean);
      addActivity({
        kind: "system",
        text: `Lead from ${SOURCES[source] ?? source}${parts.length ? `\n${parts.join("\n")}` : ""}`.slice(0, 20000),
        deal: id,
        contact: contact?.id ?? null,
        by,
        event: "lead",
        data: { source, chatUrl, page, referrer, utm, pages: read },
      });
      return { status: 201 as const, body: answer(mustDeal(id), true) };
    });
  }

  // ------------------------------------------------------------------ Audience: deletion on request

  /**
   * POST /api/v1/erasures, as Audience calls it: every contact with one of the emails or phone numbers is deleted with
   * their activities and tasks; deals with no company that were theirs alone go with them, and the others keep the
   * company's side without the person. Bookings and queued events with the identifiers go too. The same reference
   * answers the same way again.
   */
  function erase(raw: unknown) {
    const b = body(raw, ["reference", "product", "people"]);
    const reference = text(b.reference, "reference", 100);
    if (!isObj(b.people)) throw bad("people is { emails, phones, userIds }.");
    const seen = one<{ deleted: number }>("SELECT deleted FROM erasures WHERE reference = ?", reference);
    if (seen) return { status: "done" as const, deleted: seen.deleted };
    const list = (v: unknown, field: string) => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.length > 1000 || v.some((x) => typeof x !== "string")) throw bad(`people.${field} is a list of texts.`);
      return v as string[];
    };
    const emails = list(b.people.emails, "emails")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const phones = list(b.people.phones, "phones")
      .map(phoneKey)
      .filter((p): p is string => !!p);
    list(b.people.userIds, "userIds");
    return tx(() => {
      const contacts = q<ContactRow>("SELECT * FROM contacts").filter(
        (c) => (c.email && emails.includes(c.email)) || (phoneKey(c.phone) && phones.includes(phoneKey(c.phone)!)),
      );
      for (const c of contacts) {
        run("DELETE FROM deals WHERE contact_id = ? AND company_id IS NULL", c.id);
        run("DELETE FROM activities WHERE contact_id = ? AND deal_id IS NOT NULL AND event IN ('lead', 'booking')", c.id);
        run("DELETE FROM contacts WHERE id = ?", c.id);
      }
      for (const e of emails) {
        run("DELETE FROM bookings WHERE email = ?", e);
        run("DELETE FROM outbox WHERE email = ?", e);
      }
      for (const p of phones) run("DELETE FROM outbox WHERE phone = ?", p);
      run("INSERT INTO erasures (reference, at, deleted) VALUES (?, ?, ?)", reference, iso(), contacts.length);
      log("info", "erased on Audience's request", { reference, contacts: contacts.length });
      return { status: "done" as const, deleted: contacts.length };
    });
  }

  // ------------------------------------------------------------------ Audience: the lead's profile on the deal

  async function audienceProfile(id: string) {
    const d = mustDeal(id);
    const c = cfg();
    if (!c.audience?.profile || !audience) return { linked: false, found: false, url: null, profile: null };
    const contact = contactRow(d.contact_id);
    if (!contact?.email) return { linked: true, found: false, url: null, profile: null };
    try {
      const p = await audience.profile(contact.email, clock());
      linkOk("audience");
      return { linked: true, found: !!p, url: p ? `${c.audience.url}/people/${encodeURIComponent(p.id)}` : null, profile: p };
    } catch (err) {
      linkFailed("audience", err);
      throw new CrmError(502, "link-failed", `Audience did not answer: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ meeting bookings land here

  /** A booked meeting: the contact found or made by email, and the deal it adds to or opens. */
  function fromBooking(b: {
    link: string;
    pipeline: string;
    stage: string;
    owner: { id: string; name: string } | null;
    name: string;
    email: string;
    company: string | null;
    note: string | null;
    start: string;
    joinUrl: string | null;
    title: string;
  }) {
    let contact = one<ContactRow>("SELECT * FROM contacts WHERE email = ?", b.email);
    let made: "created" | "added";
    const company = b.company ? companyByName(b.company, b.owner) : (contact?.company_id ?? null);
    if (!contact)
      contact = mustContact(insertContact({ name: b.name, email: b.email, phone: null, title: null, company, owner: b.owner, source: "meeting-link" }));
    else if (!contact.company_id && company) run("UPDATE contacts SET company_id = ?, updated_at = ? WHERE id = ?", company, iso(), contact.id);
    let deal = one<DealRow>(
      "SELECT * FROM deals WHERE contact_id = ? AND pipeline = ? AND status = 'open' ORDER BY updated_at DESC LIMIT 1",
      contact.id,
      b.pipeline,
    );
    if (deal) made = "added";
    else {
      made = "created";
      deal = mustDeal(
        insertDeal({
          name: b.company ? `${b.title}, ${b.company}` : b.title,
          pipeline: b.pipeline,
          stage: b.stage,
          valueMinor: 0,
          company,
          contact: contact.id,
          owner: b.owner,
          expectedClose: null,
          source: "meeting-link",
          sourceDetail: b.link,
          by: b.name,
        }),
      );
    }
    addActivity({
      kind: "meeting",
      text: `${b.title} booked by ${b.name} for ${b.start}${b.note ? `: ${b.note}` : ""}`,
      deal: deal.id,
      contact: contact.id,
      by: { id: null, name: b.name },
      event: "booking",
      data: { link: b.link, start: b.start, joinUrl: b.joinUrl },
    });
    return { contact: contact.id, deal: deal.id, made, stage: stageOf(deal.pipeline, deal.stage)?.name ?? deal.stage };
  }

  // ------------------------------------------------------------------ housekeeping

  async function tick() {
    await flush().catch((err) => log("error", "outbox round failed", { error: String(err) }));
    await remind().catch((err) => log("error", "reminder round failed", { error: String(err) }));
  }

  function gauges() {
    const deals: Record<string, number> = {};
    for (const r of q<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM deals GROUP BY status")) deals[r.status] = r.n;
    const outbox: Record<string, number> = {};
    for (const r of q<{ target: string; n: number }>("SELECT target, COUNT(*) AS n FROM outbox GROUP BY target")) outbox[r.target] = r.n;
    const stale = config ? q<DealRow>("SELECT * FROM deals WHERE status = 'open'").filter(isStale).length : 0;
    return { deals, stale, outbox, counters };
  }

  function integrations() {
    const pending = (t: string) => one<{ n: number; error: string | null }>("SELECT COUNT(*) AS n, MAX(error) AS error FROM outbox WHERE target = ?", t)!;
    const c = config;
    return {
      audience: {
        linked: !!c?.audience,
        url: c?.audience?.url ?? null,
        tokenSet: !!(c?.audience && env[c.audience.token]),
        ...links.audience,
        queued: pending("audience").n,
      },
      messages: {
        linked: !!c?.messages,
        url: c?.messages?.url ?? null,
        tokenSet: !!(c?.messages && env[c.messages.token]),
        ...links.messages,
        queued: pending("messages").n,
        sequences: c?.messages?.sequences ?? [],
      },
      mail: { configured: !!c?.mail, host: c?.mail?.host ?? null, ...links.mail },
    };
  }

  return {
    store,
    config: () => config,
    cfg,
    setConfig,
    settings,
    team,
    canChange,
    memberByEmail,
    selfOwner,
    count,
    counters,
    // records
    listCompanies,
    getCompany,
    createCompany,
    updateCompany,
    removeCompany,
    listContacts,
    getContact,
    createContact,
    updateContact,
    removeContact,
    listDeals,
    getDeal,
    createDeal,
    updateDeal,
    moveDeal,
    closeDeal,
    reopenDeal,
    removeDeal,
    listActivities,
    logActivity,
    removeActivity,
    listTasks,
    createTask,
    updateTask,
    removeTask,
    createQuote,
    getQuote,
    updateQuote,
    removeQuote,
    sendQuote,
    decideQuote,
    quoteFile,
    startSequence,
    report,
    summary,
    importCsv,
    // contracts
    lookup,
    openLead,
    erase,
    audienceProfile,
    fromBooking,
    // background
    flush,
    remind,
    tick,
    gauges,
    integrations,
  };
}

export type Crm = ReturnType<typeof createCrm>;
