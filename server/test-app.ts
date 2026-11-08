// Starts the app on a random port for tests, with the fakes of Google, Microsoft, Audience and Messages, and a mailer
// that keeps what it is given.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { parseConfig } from "./config.ts";
import { createCrm } from "./crm.ts";
import { openDb } from "./db.ts";
import { AUDIENCE_TOKEN, GOOGLE, MESSAGES_TOKEN, MICROSOFT, startFakes } from "./fakes.ts";
import type { Mail, Mailer } from "./links.ts";
import { createMeetings } from "./meetings.ts";
import type { Actor } from "./store.ts";

export const ADMIN_TOKEN = "test-admin-token";

/** Members of the test install: Emily is an editor, Hakan an editor, Selin an admin, Veli a viewer. */
export const EMILY: Actor = { id: "user-emily", name: "Emily Clark", role: "editor" };
export const HAKAN: Actor = { id: "user-hakan", name: "Hakan Yıldız", role: "editor" };
export const SELIN: Actor = { id: "user-selin", name: "Selin Aydın", role: "admin" };
export const VELI: Actor = { id: "user-veli", name: "Veli Kaya", role: "viewer" };
const MEMBERS = [
  { ...EMILY, email: "emily@example.com" },
  { ...HAKAN, email: "hakan@example.com" },
  { ...SELIN, email: "selin@example.com" },
  { ...VELI, email: "veli@example.com" },
];

/** The settings file the tests start with; FAKES is replaced with the fake server's address. */
export const SETTINGS = `
currency: TRY
time_zone: Europe/Istanbul
pipelines:
  sales:
    stages:
      - { id: lead, name: Lead, probability: 10%, stale_after: 14d }
      - { id: demo, name: Demo, probability: 25%, stale_after: 10d }
      - { id: proposal, name: Proposal, probability: 50%, stale_after: 10d }
      - { id: negotiation, name: Negotiation, probability: 75%, stale_after: 7d }
    lost_reasons: [Chose a cheaper tool, Not this year, Stopped answering]
plans:
  free: Free
  business: { name: Business }
leads:
  stage: lead
  owner: emily@example.com
quotes:
  vat: 20%
  language: tr
  seller: { name: Acme Yazılım A.Ş., address: "Büyükdere Cad. 1, Şişli, İstanbul", tax_office: Zincirlikuyu, tax_number: "1234567890" }
tasks:
  remind_at: "08:00"
mail: { host: localhost, port: 2525, security: none, from: CRM <crm@example.com> }
calendars:
  google: { client_id: G_ID, client_secret: G_SECRET }
  microsoft: { client_id: M_ID, client_secret: M_SECRET }
meeting_links:
  demo:
    name: Acme demo
    owner: emily@example.com
    length: 30m
    hours: weekdays 09:00-12:00
    buffer: 15m
    notice: 2h
    days_ahead: 7
    creates_deal_in: demo
  intro:
    name: Intro call
    owner: hakan@example.com
    length: 30m
    hours: weekdays 14:00-17:00
audience: { url: FAKES/audience, token: AUD_TOKEN }
messages:
  url: FAKES/messages
  token: MSG_TOKEN
  sequences:
    follow-up: { name: Demo follow-up, event: crm_demo_follow_up }
`;

/** A clock the test moves by hand: Monday 2 November 2026, 09:00 in Istanbul. */
export function fakeClock(start = Date.parse("2026-11-02T06:00:00Z")) {
  let t = start;
  return Object.assign(() => t, { advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) });
}

export async function startApp(opts: Partial<AppOptions> & { version?: string; settings?: string } = {}) {
  const fakes = await startFakes();
  const db = openDb(":memory:");
  const { settings = SETTINGS, version = "0.1.0", ...rest } = opts;
  const clock = fakeClock();
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "crm", productName: "OpenAsy CRM", origin: base });
  for (const m of MEMBERS)
    db.prepare("INSERT INTO auth_users (id, email, name, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)").run(
      m.id,
      m.email,
      m.name,
      m.role,
      new Date().toISOString(),
    );
  const mails: Mail[] = [];
  const mailer: Mailer & { fail: boolean } = {
    fail: false,
    async send(m) {
      if (this.fail) throw new Error("connect ECONNREFUSED");
      mails.push(m);
    },
    close() {},
  };
  const env = {
    G_ID: GOOGLE.clientId,
    G_SECRET: GOOGLE.clientSecret,
    M_ID: MICROSOFT.clientId,
    M_SECRET: MICROSOFT.clientSecret,
    AUD_TOKEN: AUDIENCE_TOKEN,
    MSG_TOKEN: MESSAGES_TOKEN,
  };
  const crm = createCrm(db, { publicUrl: base, env, clock, mailer: (c) => (c.mail ? mailer : null) });
  const meetings = createMeetings(crm, { publicUrl: base, env, endpoints: fakes.endpoints, secretsKey: Buffer.alloc(32, 7) });
  const text = settings.replaceAll("FAKES", fakes.base);
  crm.setConfig(parseConfig(text), text);
  handler = createApp({ db, crm, meetings, auth, adminToken: ADMIN_TOKEN, version, ...rest });
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fakes.close();
  };
  return { db, crm, meetings, auth, base, admin, clock, fakes, mails, mailer, close };
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;

/** Connects a member's calendar the way a browser would: the OAuth start, the provider's code, the callback. */
export async function connectCalendar(app: TestApp, who: Actor, provider: "google" | "microsoft", account: string) {
  const { url } = app.meetings.connect(who, { provider });
  const state = new URL(url).searchParams.get("state")!;
  const to = await app.meetings.callback(
    who,
    new URL(`${app.base}/api/v1/calendar/callback?${new URLSearchParams({ state, code: app.fakes.code(provider, account) })}`),
  );
  return { url, to };
}
