// The calendars a meeting link reads free times from and writes its meetings to: Google Calendar and Microsoft 365
// (Outlook) through Microsoft Graph, both with OAuth 2.0 (authorization code, offline access). Both are behind one
// interface, so the booking code never knows which one it talks to, and the tests point both at a fake server
// (fakes.ts) that answers as each provider documents. Only the person who connects a calendar is read: CRM asks for
// free/busy and event creation, never for the events' contents.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type CalendarKind = "google" | "microsoft";

export interface Tokens {
  accessToken: string;
  /** null when the provider did not send a new one; the old one stays. */
  refreshToken: string | null;
  /** When the access token ends, in ms. */
  expiresAt: number;
}

export interface Busy {
  start: number;
  end: number;
}

export interface NewEvent {
  start: number;
  end: number;
  title: string;
  description: string;
  attendee: { name: string; email: string };
  /** For the invitation's times; the instants are what count. */
  timeZone: string;
  /** Ask for a Meet or Teams link. */
  online: boolean;
  /** The same id makes the same event once (Google's requestId, Graph's transactionId). */
  requestId: string;
}

export interface CreatedEvent {
  id: string;
  /** The event in the owner's calendar. */
  url: string | null;
  /** Meet or Teams, when one was made. */
  joinUrl: string | null;
}

export class CalendarError extends Error {
  /** true when the person must connect the calendar again: the grant was revoked or expired. */
  readonly reconnect: boolean;
  readonly status: number | null;
  constructor(message: string, { reconnect = false, status = null }: { reconnect?: boolean; status?: number | null } = {}) {
    super(message);
    this.reconnect = reconnect;
    this.status = status;
  }
}

export interface CalendarProvider {
  readonly kind: CalendarKind;
  /** Where the person's browser goes to allow CRM in their calendar. */
  authUrl(o: { state: string; redirectUri: string; loginHint?: string }): string;
  /** The code the provider sent back, for tokens and the account's email address. */
  exchange(code: string, redirectUri: string): Promise<Tokens & { account: string }>;
  refresh(refreshToken: string): Promise<Tokens>;
  /** Busy times in the account's main calendar between two instants. */
  busy(accessToken: string, account: string, from: number, to: number): Promise<Busy[]>;
  createEvent(accessToken: string, event: NewEvent): Promise<CreatedEvent>;
  cancelEvent(accessToken: string, id: string): Promise<void>;
}

/** Addresses the providers are reached at; the tests set them to a fake server. */
export interface Endpoints {
  google?: { auth?: string; token?: string; api?: string; userinfo?: string };
  microsoft?: { login?: string; graph?: string };
}

type Fetch = typeof fetch;
const TIMEOUT = 10_000;

async function call(f: Fetch, url: string, init: RequestInit, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT), redirect: "error" });
  } catch (err) {
    throw new CalendarError(`${what} could not be reached: ${(err as Error).message}`);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = body as { error?: unknown; error_description?: unknown } | null;
    const code = typeof b?.error === "string" ? b.error : typeof (b?.error as { code?: unknown })?.code === "string" ? (b!.error as { code: string }).code : "";
    const message =
      typeof b?.error_description === "string"
        ? b.error_description
        : typeof (b?.error as { message?: unknown })?.message === "string"
          ? (b!.error as { message: string }).message
          : "";
    // invalid_grant: the refresh token was revoked or ran out. 401 on an API call after a refresh: same.
    const reconnect = code === "invalid_grant" || code === "InvalidAuthenticationToken" || res.status === 401;
    throw new CalendarError(`${what} answered ${res.status}${code ? ` ${code}` : ""}${message ? `: ${message.split("\n")[0]!.slice(0, 200)}` : ""}`, {
      reconnect,
      status: res.status,
    });
  }
  return body;
}

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  body: new URLSearchParams(fields).toString(),
});

function tokensOf(body: unknown, now: number, what: string): Tokens {
  const b = body as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown } | null;
  if (typeof b?.access_token !== "string") throw new CalendarError(`${what} sent no access token.`);
  const expires = typeof b.expires_in === "number" ? b.expires_in : Number(b.expires_in ?? 3600) || 3600;
  return { accessToken: b.access_token, refreshToken: typeof b.refresh_token === "string" ? b.refresh_token : null, expiresAt: now + expires * 1000 };
}

/** Graph's dateTime is the wall clock in the zone asked for; CRM always asks for UTC. */
const graphTime = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace("Z", "")
    .replace(/\.\d+$/, "");
const fromGraph = (v: { dateTime?: unknown } | undefined) => {
  const s = typeof v?.dateTime === "string" ? v.dateTime : "";
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`);
};

export function googleCalendar(o: {
  clientId: string;
  clientSecret: string;
  endpoints?: Endpoints["google"];
  fetch?: Fetch;
  now?: () => number;
}): CalendarProvider {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const auth = o.endpoints?.auth ?? "https://accounts.google.com/o/oauth2/v2/auth";
  const token = o.endpoints?.token ?? "https://oauth2.googleapis.com/token";
  const api = o.endpoints?.api ?? "https://www.googleapis.com";
  const userinfo = o.endpoints?.userinfo ?? "https://openidconnect.googleapis.com/v1/userinfo";
  const bearer = (t: string) => ({ authorization: `Bearer ${t}`, accept: "application/json", "content-type": "application/json" });
  return {
    kind: "google",
    authUrl({ state, redirectUri, loginHint }) {
      const q = new URLSearchParams({
        client_id: o.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        // Free/busy to offer times, events to put the meeting in; nothing that reads what events say.
        scope: "openid email https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events",
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
        ...(loginHint ? { login_hint: loginHint } : {}),
      });
      return `${auth}?${q}`;
    },
    async exchange(code, redirectUri) {
      const body = await call(
        f,
        token,
        form({ code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
        "Google",
      );
      const t = tokensOf(body, now(), "Google");
      if (!t.refreshToken) throw new CalendarError("Google sent no refresh token; remove CRM's access in the Google account and connect again.");
      const me = (await call(f, userinfo, { headers: bearer(t.accessToken) }, "Google")) as { email?: unknown } | null;
      if (typeof me?.email !== "string") throw new CalendarError("Google did not say which account this is.");
      return { ...t, account: me.email.toLowerCase() };
    },
    async refresh(refreshToken) {
      const body = await call(
        f,
        token,
        form({ refresh_token: refreshToken, client_id: o.clientId, client_secret: o.clientSecret, grant_type: "refresh_token" }),
        "Google",
      );
      return tokensOf(body, now(), "Google");
    },
    async busy(accessToken, _account, from, to) {
      const body = (await call(
        f,
        `${api}/calendar/v3/freeBusy`,
        {
          method: "POST",
          headers: bearer(accessToken),
          body: JSON.stringify({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: [{ id: "primary" }] }),
        },
        "Google Calendar",
      )) as { calendars?: Record<string, { busy?: Array<{ start?: string; end?: string }>; errors?: Array<{ reason?: string }> }> } | null;
      const cal = body?.calendars?.primary;
      if (!cal) throw new CalendarError("Google Calendar sent no free/busy for the primary calendar.");
      if (cal.errors?.length) throw new CalendarError(`Google Calendar could not read free/busy: ${cal.errors.map((e) => e.reason).join(", ")}`);
      return (cal.busy ?? []).map((b) => ({ start: Date.parse(b.start ?? ""), end: Date.parse(b.end ?? "") })).filter((b) => b.end > b.start);
    },
    async createEvent(accessToken, e) {
      const body = (await call(
        f,
        `${api}/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`,
        {
          method: "POST",
          headers: bearer(accessToken),
          body: JSON.stringify({
            summary: e.title,
            description: e.description,
            start: { dateTime: new Date(e.start).toISOString(), timeZone: e.timeZone },
            end: { dateTime: new Date(e.end).toISOString(), timeZone: e.timeZone },
            attendees: [{ email: e.attendee.email, displayName: e.attendee.name }],
            ...(e.online && { conferenceData: { createRequest: { requestId: e.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } } }),
          }),
        },
        "Google Calendar",
      )) as { id?: unknown; htmlLink?: unknown; hangoutLink?: unknown } | null;
      if (typeof body?.id !== "string") throw new CalendarError("Google Calendar sent no event id.");
      return {
        id: body.id,
        url: typeof body.htmlLink === "string" ? body.htmlLink : null,
        joinUrl: typeof body.hangoutLink === "string" ? body.hangoutLink : null,
      };
    },
    async cancelEvent(accessToken, id) {
      await call(
        f,
        `${api}/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=all`,
        { method: "DELETE", headers: bearer(accessToken) },
        "Google Calendar",
      );
    },
  };
}

export function microsoftCalendar(o: {
  clientId: string;
  clientSecret: string;
  tenant: string;
  endpoints?: Endpoints["microsoft"];
  fetch?: Fetch;
  now?: () => number;
}): CalendarProvider {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const login = `${o.endpoints?.login ?? "https://login.microsoftonline.com"}/${encodeURIComponent(o.tenant)}/oauth2/v2.0`;
  const graph = o.endpoints?.graph ?? "https://graph.microsoft.com";
  const SCOPE = "offline_access openid email User.Read Calendars.ReadWrite";
  // Graph answers times in the zone Prefer names; UTC keeps them instants.
  const bearer = (t: string) => ({
    authorization: `Bearer ${t}`,
    accept: "application/json",
    "content-type": "application/json",
    prefer: 'outlook.timezone="UTC"',
  });
  return {
    kind: "microsoft",
    authUrl({ state, redirectUri, loginHint }) {
      const q = new URLSearchParams({
        client_id: o.clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        response_mode: "query",
        scope: SCOPE,
        state,
        prompt: "select_account",
        ...(loginHint ? { login_hint: loginHint } : {}),
      });
      return `${login}/authorize?${q}`;
    },
    async exchange(code, redirectUri) {
      const body = await call(
        f,
        `${login}/token`,
        form({ client_id: o.clientId, client_secret: o.clientSecret, code, redirect_uri: redirectUri, grant_type: "authorization_code", scope: SCOPE }),
        "Microsoft",
      );
      const t = tokensOf(body, now(), "Microsoft");
      if (!t.refreshToken) throw new CalendarError("Microsoft sent no refresh token; offline_access was not granted.");
      const me = (await call(f, `${graph}/v1.0/me?$select=mail,userPrincipalName`, { headers: bearer(t.accessToken) }, "Microsoft Graph")) as {
        mail?: unknown;
        userPrincipalName?: unknown;
      } | null;
      const account = typeof me?.mail === "string" && me.mail ? me.mail : typeof me?.userPrincipalName === "string" ? me.userPrincipalName : null;
      if (!account) throw new CalendarError("Microsoft Graph did not say which account this is.");
      return { ...t, account: account.toLowerCase() };
    },
    async refresh(refreshToken) {
      // Microsoft sends a new refresh token with each refresh; the old one keeps working for a while.
      const body = await call(
        f,
        `${login}/token`,
        form({ client_id: o.clientId, client_secret: o.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token", scope: SCOPE }),
        "Microsoft",
      );
      return tokensOf(body, now(), "Microsoft");
    },
    async busy(accessToken, account, from, to) {
      const body = (await call(
        f,
        `${graph}/v1.0/me/calendar/getSchedule`,
        {
          method: "POST",
          headers: bearer(accessToken),
          body: JSON.stringify({
            schedules: [account],
            startTime: { dateTime: graphTime(from), timeZone: "UTC" },
            endTime: { dateTime: graphTime(to), timeZone: "UTC" },
            availabilityViewInterval: 15,
          }),
        },
        "Microsoft Graph",
      )) as {
        value?: Array<{ scheduleItems?: Array<{ status?: string; start?: { dateTime?: string }; end?: { dateTime?: string } }>; error?: { message?: string } }>;
      } | null;
      const s = body?.value?.[0];
      if (!s) throw new CalendarError("Microsoft Graph sent no schedule.");
      if (s.error) throw new CalendarError(`Microsoft Graph could not read the schedule: ${s.error.message ?? "unknown"}`);
      // free and workingElsewhere leave the time open; busy, tentative and oof do not.
      return (s.scheduleItems ?? [])
        .filter((i) => i.status !== "free" && i.status !== "workingElsewhere")
        .map((i) => ({ start: fromGraph(i.start), end: fromGraph(i.end) }))
        .filter((b) => b.end > b.start);
    },
    async createEvent(accessToken, e) {
      const body = (await call(
        f,
        `${graph}/v1.0/me/events`,
        {
          method: "POST",
          headers: bearer(accessToken),
          body: JSON.stringify({
            subject: e.title,
            body: { contentType: "text", content: e.description },
            start: { dateTime: graphTime(e.start), timeZone: "UTC" },
            end: { dateTime: graphTime(e.end), timeZone: "UTC" },
            attendees: [{ emailAddress: { address: e.attendee.email, name: e.attendee.name }, type: "required" }],
            transactionId: e.requestId,
            ...(e.online && { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" }),
          }),
        },
        "Microsoft Graph",
      )) as { id?: unknown; webLink?: unknown; onlineMeeting?: { joinUrl?: unknown } | null } | null;
      if (typeof body?.id !== "string") throw new CalendarError("Microsoft Graph sent no event id.");
      return {
        id: body.id,
        url: typeof body.webLink === "string" ? body.webLink : null,
        joinUrl: typeof body.onlineMeeting?.joinUrl === "string" ? body.onlineMeeting.joinUrl : null,
      };
    },
    async cancelEvent(accessToken, id) {
      await call(
        f,
        `${graph}/v1.0/me/events/${encodeURIComponent(id)}/cancel`,
        { method: "POST", headers: bearer(accessToken), body: JSON.stringify({ comment: "Cancelled in CRM." }) },
        "Microsoft Graph",
      );
    },
  };
}

// ------------------------------------------------------------------ tokens at rest

/**
 * Calendar tokens are encrypted with the product's key (AES-256-GCM, ADR 0021) before they are stored. Without a key
 * they are kept in clear, marked so, and the start log says so.
 */
export function sealer(key: Buffer | undefined) {
  return {
    seal(text: string): string {
      if (!key) return `plain:${text}`;
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
      return `v1:${Buffer.concat([iv, c.getAuthTag(), data]).toString("base64")}`;
    },
    open(sealed: string): string {
      if (sealed.startsWith("plain:")) return sealed.slice(6);
      if (!key) throw new CalendarError("The calendar tokens are encrypted and the product's key is not mounted.");
      const raw = Buffer.from(sealed.slice(3), "base64");
      const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
    },
  };
}
