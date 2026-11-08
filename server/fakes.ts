// Fakes of what CRM talks to, on one local HTTP server, for the tests: Google's OAuth and Calendar APIs, Microsoft's
// identity platform and Graph, and Audience's and Messages' event APIs. Each answers in the shape its documentation
// gives and checks what a real one would refuse (client secrets, bearer tokens, codes used once, Graph's UTC times).
// They are not the real services: what passes here is tested against these fakes only.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Busy, Endpoints } from "./calendar.ts";

export const GOOGLE = { clientId: "google-client", clientSecret: "google-secret" };
export const MICROSOFT = { clientId: "ms-client", clientSecret: "ms-secret", tenant: "common" };
export const AUDIENCE_TOKEN = "audience-token-for-crm";
export const MESSAGES_TOKEN = "messages-token-for-crm";

interface FakeEvent {
  provider: "google" | "microsoft";
  account: string;
  id: string;
  start: number;
  end: number;
  title: string;
  attendee: string;
  online: boolean;
  requestId: string;
  cancelled: boolean;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFakes() {
  const state = {
    /** Busy times by account, as the calendar has them. */
    busy: new Map<string, Busy[]>(),
    events: [] as FakeEvent[],
    codes: new Map<string, { provider: "google" | "microsoft"; account: string }>(),
    access: new Map<string, { account: string; expiresAt: number }>(),
    refresh: new Map<string, string>(),
    /** Calls by path, to see what CRM asked. */
    calls: [] as Array<{ method: string; path: string; body: string; headers: IncomingMessage["headers"] }>,
    /** The next event creation fails with this status. */
    failCreate: 0,
    /** Waits this long before answering free/busy, so concurrent bookings overlap. */
    busyDelayMs: 0,
    audience: {
      events: [] as Array<Record<string, unknown>>,
      status: 200,
      people: new Map<string, { id: string; events: Array<Record<string, unknown>> }>(),
    },
    messages: { events: [] as Array<Record<string, unknown>>, status: 200 },
  };

  const send = (res: ServerResponse, status: number, data: unknown) => {
    const text = data === undefined ? "" : JSON.stringify(data);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
  };
  const who = (req: IncomingMessage) => {
    const t = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const a = state.access.get(t);
    return a && a.expiresAt > Date.now() ? a.account : null;
  };
  const issue = (provider: "google" | "microsoft", account: string, withRefresh: boolean) => {
    const access = `at-${randomBytes(8).toString("hex")}`;
    state.access.set(access, { account, expiresAt: Date.now() + 3600_000 });
    const out: Record<string, unknown> = { access_token: access, expires_in: 3600, token_type: "Bearer" };
    if (withRefresh) {
      const r = `rt-${provider}-${randomBytes(8).toString("hex")}`;
      state.refresh.set(r, account);
      out.refresh_token = r;
    }
    return out;
  };
  const busyFor = (account: string, from: number, to: number) => [
    ...(state.busy.get(account) ?? []).filter((b) => b.end > from && b.start < to),
    ...state.events.filter((e) => e.account === account && !e.cancelled && e.end > from && e.start < to),
  ];

  function token(text: string, res: ServerResponse, provider: "google" | "microsoft") {
    const f = new URLSearchParams(text);
    const id = provider === "google" ? GOOGLE : MICROSOFT;
    if (f.get("client_id") !== id.clientId || f.get("client_secret") !== id.clientSecret)
      return send(res, 401, { error: "invalid_client", error_description: "The client secret is wrong." });
    if (f.get("grant_type") === "authorization_code") {
      const c = state.codes.get(f.get("code") ?? "");
      if (!c || c.provider !== provider || !f.get("redirect_uri")) return send(res, 400, { error: "invalid_grant", error_description: "Bad code." });
      state.codes.delete(f.get("code")!);
      return send(res, 200, issue(provider, c.account, true));
    }
    if (f.get("grant_type") === "refresh_token") {
      const account = state.refresh.get(f.get("refresh_token") ?? "");
      if (!account) return send(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      // Microsoft rotates refresh tokens; Google does not send a new one.
      return send(res, 200, issue(provider, account, provider === "microsoft"));
    }
    send(res, 400, { error: "unsupported_grant_type" });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const text = req.method === "GET" || req.method === "DELETE" ? "" : await body(req);
    state.calls.push({ method: req.method ?? "GET", path: p + url.search, body: text, headers: req.headers });
    const json = () => (text ? (JSON.parse(text) as Record<string, any>) : {});

    // ---------------------------------------------------------------- Google
    if (p === "/google/token" && req.method === "POST") return token(text, res, "google");
    if (p === "/google/userinfo") {
      const a = who(req);
      return a ? send(res, 200, { sub: "1", email: a, email_verified: true }) : send(res, 401, { error: "invalid_token" });
    }
    if (p === "/google/api/calendar/v3/freeBusy" && req.method === "POST") {
      const a = who(req);
      if (!a) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      const b = json();
      if (state.busyDelayMs) await new Promise((r) => setTimeout(r, state.busyDelayMs));
      const busy = busyFor(a, Date.parse(b.timeMin), Date.parse(b.timeMax)).map((x) => ({
        start: new Date(x.start).toISOString(),
        end: new Date(x.end).toISOString(),
      }));
      return send(res, 200, { kind: "calendar#freeBusy", timeMin: b.timeMin, timeMax: b.timeMax, calendars: { primary: { busy } } });
    }
    if (p === "/google/api/calendar/v3/calendars/primary/events" && req.method === "POST") {
      const a = who(req);
      if (!a) return send(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
      if (url.searchParams.get("conferenceDataVersion") !== "1") return send(res, 400, { error: { code: 400, message: "conferenceDataVersion" } });
      if (state.failCreate) {
        const status = state.failCreate;
        state.failCreate = 0;
        return send(res, status, { error: { code: status, message: "Backend Error" } });
      }
      const b = json();
      const e: FakeEvent = {
        provider: "google",
        account: a,
        id: `g-${randomBytes(6).toString("hex")}`,
        start: Date.parse(b.start.dateTime),
        end: Date.parse(b.end.dateTime),
        title: b.summary,
        attendee: b.attendees?.[0]?.email,
        online: !!b.conferenceData,
        requestId: b.conferenceData?.createRequest?.requestId ?? "",
        cancelled: false,
      };
      state.events.push(e);
      return send(res, 200, {
        id: e.id,
        status: "confirmed",
        htmlLink: `https://calendar.google.com/event?eid=${e.id}`,
        ...(e.online && { hangoutLink: `https://meet.google.com/abc-${e.id.slice(2, 6)}-xyz` }),
      });
    }
    const gDel = /^\/google\/api\/calendar\/v3\/calendars\/primary\/events\/([^/]+)$/.exec(p);
    if (gDel && req.method === "DELETE") {
      const e = state.events.find((x) => x.id === decodeURIComponent(gDel[1]!));
      if (!who(req)) return send(res, 401, {});
      if (!e) return send(res, 404, { error: { code: 404, message: "Not Found" } });
      e.cancelled = true;
      res.writeHead(204).end();
      return;
    }

    // ---------------------------------------------------------------- Microsoft
    if (/^\/ms\/login\/[^/]+\/oauth2\/v2\.0\/token$/.test(p) && req.method === "POST") return token(text, res, "microsoft");
    const msUnauth = () => send(res, 401, { error: { code: "InvalidAuthenticationToken", message: "Access token has expired or is not yet valid." } });
    if (p === "/ms/graph/v1.0/me") {
      const a = who(req);
      return a ? send(res, 200, { mail: a, userPrincipalName: a }) : msUnauth();
    }
    // Graph's times have no zone: they are in the zone Prefer names, and CRM asks for UTC.
    const graphTime = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}.0000000`;
    if (p === "/ms/graph/v1.0/me/calendar/getSchedule" && req.method === "POST") {
      const a = who(req);
      if (!a) return msUnauth();
      if (req.headers.prefer !== 'outlook.timezone="UTC"') return send(res, 400, { error: { code: "ErrorInvalidTimeZone", message: "Ask for UTC." } });
      const b = json();
      if (b.startTime?.timeZone !== "UTC" || String(b.startTime?.dateTime).endsWith("Z"))
        return send(res, 400, { error: { code: "ErrorInvalidRequest", message: "dateTime without a zone" } });
      if (state.busyDelayMs) await new Promise((r) => setTimeout(r, state.busyDelayMs));
      const items = busyFor(a, Date.parse(`${b.startTime.dateTime}Z`), Date.parse(`${b.endTime.dateTime}Z`)).map((x) => ({
        status: "busy",
        start: { dateTime: graphTime(x.start), timeZone: "UTC" },
        end: { dateTime: graphTime(x.end), timeZone: "UTC" },
      }));
      // A free item and a working-elsewhere one, which leave the time open.
      items.push({
        status: "workingElsewhere",
        start: { dateTime: graphTime(Date.parse(`${b.startTime.dateTime}Z`)), timeZone: "UTC" },
        end: { dateTime: graphTime(Date.parse(`${b.endTime.dateTime}Z`)), timeZone: "UTC" },
      });
      return send(res, 200, { value: [{ scheduleId: b.schedules?.[0], availabilityView: "", scheduleItems: items }] });
    }
    if (p === "/ms/graph/v1.0/me/events" && req.method === "POST") {
      const a = who(req);
      if (!a) return msUnauth();
      if (state.failCreate) {
        const status = state.failCreate;
        state.failCreate = 0;
        return send(res, status, { error: { code: "ServiceNotAvailable", message: "Try again." } });
      }
      const b = json();
      if (b.start?.timeZone !== "UTC") return send(res, 400, { error: { code: "ErrorInvalidRequest", message: "zone" } });
      const e: FakeEvent = {
        provider: "microsoft",
        account: a,
        id: `m-${randomBytes(6).toString("hex")}`,
        start: Date.parse(`${b.start.dateTime}Z`),
        end: Date.parse(`${b.end.dateTime}Z`),
        title: b.subject,
        attendee: b.attendees?.[0]?.emailAddress?.address,
        online: !!b.isOnlineMeeting,
        requestId: b.transactionId ?? "",
        cancelled: false,
      };
      state.events.push(e);
      return send(res, 201, {
        id: e.id,
        webLink: `https://outlook.office365.com/owa/?itemid=${e.id}`,
        onlineMeeting: e.online ? { joinUrl: `https://teams.microsoft.com/l/meetup-join/${e.id}` } : null,
      });
    }
    const mCancel = /^\/ms\/graph\/v1\.0\/me\/events\/([^/]+)\/cancel$/.exec(p);
    if (mCancel && req.method === "POST") {
      if (!who(req)) return msUnauth();
      const e = state.events.find((x) => x.id === decodeURIComponent(mCancel[1]!));
      if (!e) return send(res, 404, { error: { code: "ErrorItemNotFound", message: "Not found" } });
      e.cancelled = true;
      res.writeHead(202).end();
      return;
    }

    // ---------------------------------------------------------------- Audience
    const bearerIs = (t: string) => req.headers.authorization === `Bearer ${t}`;
    if (p === "/audience/api/v1/events" && req.method === "POST") {
      if (!bearerIs(AUDIENCE_TOKEN)) return send(res, 401, { code: "unauthenticated", status: 401, title: "Unauthenticated", type: "x" });
      if (state.audience.status !== 200)
        return send(res, state.audience.status, { code: "internal-error", status: state.audience.status, title: "x", type: "x" });
      const events = json().events as Array<Record<string, unknown>>;
      state.audience.events.push(...events);
      return send(res, 200, {
        recorded: events.length,
        duplicates: 0,
        results: events.map((_e, i) => ({ profile: `p-${i}`, created: false, merged: [], conflicts: 0, event: i + 1, duplicate: false, ignoredTraits: [] })),
      });
    }
    if (p === "/audience/api/v1/people" && req.method === "GET") {
      if (!bearerIs(AUDIENCE_TOKEN)) return send(res, 401, {});
      const email = (url.searchParams.get("email") ?? "").toLowerCase();
      const person = state.audience.people.get(email);
      return send(res, 200, {
        people: person
          ? [
              {
                id: person.id,
                name: null,
                email,
                phone: null,
                userId: null,
                emails: [email],
                phones: [],
                traits: { plan: "Business" },
                sources: ["analytics", "crm"],
                firstSource: "analytics",
                createdAt: "2026-10-01T00:00:00Z",
                lastAt: null,
              },
            ]
          : [],
        total: person ? 1 : 0,
      });
    }
    const pEvents = /^\/audience\/api\/v1\/people\/([^/]+)\/events$/.exec(p);
    if (pEvents && req.method === "GET") {
      if (!bearerIs(AUDIENCE_TOKEN)) return send(res, 401, {});
      const person = [...state.audience.people.values()].find((x) => x.id === pEvents[1]);
      return person ? send(res, 200, { events: person.events }) : send(res, 404, {});
    }

    // ---------------------------------------------------------------- Messages
    if (p === "/messages/api/v1/events" && req.method === "POST") {
      if (!bearerIs(MESSAGES_TOKEN)) return send(res, 401, {});
      if (state.messages.status !== 200) return send(res, state.messages.status, { code: "invalid-body", detail: "No." });
      const events = json().events as Array<Record<string, unknown>>;
      state.messages.events.push(...events);
      return send(res, 200, { received: events.length, started: 1, converted: 0 });
    }

    send(res, 404, { error: "not found", path: p });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoints: Endpoints = {
    google: { auth: `${base}/google/auth`, token: `${base}/google/token`, api: `${base}/google/api`, userinfo: `${base}/google/userinfo` },
    microsoft: { login: `${base}/ms/login`, graph: `${base}/ms/graph` },
  };
  return {
    base,
    endpoints,
    state,
    /** What the provider's consent screen hands back to CRM for this account. */
    code(provider: "google" | "microsoft", account: string) {
      const c = `code-${randomBytes(6).toString("hex")}`;
      state.codes.set(c, { provider, account });
      return c;
    },
    /** Every access token ends now; the next call refreshes. */
    expireAccess() {
      for (const v of state.access.values()) v.expiresAt = 0;
    },
    /** The person removed CRM's access at the provider. */
    revoke() {
      state.refresh.clear();
      this.expireAccess();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type Fakes = Awaited<ReturnType<typeof startFakes>>;
