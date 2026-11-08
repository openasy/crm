// The other products CRM talks to, each behind a small interface so the tests can point it at a fake:
//
// - Audience: contact and deal events go to POST /api/v1/events with source crm (in the background, from the outbox),
//   and a deal shows the lead's profile from GET /api/v1/people?email= and GET /api/v1/people/{id}/events.
// - Messages: a sales sequence is a Messages journey started by an event, POST /api/v1/events; won and lost deals are
//   posted too, so a journey whose goal they are lets the person go.
// - Mail: task reminders and quotes go out through the SMTP server in the file.
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "./config.ts";

export class LinkError extends Error {
  /** true when sending the same again gives the same answer: a refused body or token. */
  readonly permanent: boolean;
  readonly status: number | null;
  constructor(message: string, status: number | null = null, permanent = false) {
    super(message);
    this.status = status;
    this.permanent = permanent;
  }
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown, max = 300): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

async function post(f: typeof fetch, url: string, token: string, body: unknown, product: string): Promise<unknown> {
  let res: Response;
  try {
    res = await f(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch (err) {
    throw new LinkError(`${product} could not be reached: ${(err as Error).message}`);
  }
  const answer = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = str(obj(answer)?.detail);
    // 4xx but 408 and 429 are the request's fault: sending it again gives the same answer.
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    throw new LinkError(`${product} answered ${res.status}${detail ? `: ${detail}` : ""}`, res.status, permanent);
  }
  return answer;
}

async function get(f: typeof fetch, url: string, token: string, product: string): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await f(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(5000), redirect: "error" });
  } catch (err) {
    throw new LinkError(`${product} could not be reached: ${(err as Error).message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok && res.status !== 404) throw new LinkError(`${product} answered ${res.status}`, res.status, res.status === 401 || res.status === 403);
  return { status: res.status, body };
}

/** An event as Audience's EventInput takes it (audience/openapi.json). */
export interface AudienceEvent {
  source: "crm";
  type: string;
  id: string;
  at: string;
  person: { email?: string | null; phone?: string | null; name?: string | null };
  properties: Record<string, unknown>;
  text: string;
}

export interface ProfileSnippet {
  id: string;
  /** Pages viewed in the last 30 days, most viewed first. */
  pages: Array<{ path: string; views: number }>;
  /** What else they did, newest first, outside what CRM itself posted. */
  recent: Array<{ at: string; source: string; type: string; text: string | null }>;
  traits: Record<string, string | number | boolean>;
}

export interface AudienceLink {
  send(events: AudienceEvent[]): Promise<void>;
  /** The person with exactly this email and what they did, or null when Audience has nobody with it. */
  profile(email: string, now: number): Promise<ProfileSnippet | null>;
}

export function audienceLink(o: { url: string; token: string | undefined; fetch?: typeof fetch }): AudienceLink {
  const f = o.fetch ?? fetch;
  const token = () => {
    if (!o.token) throw new LinkError("The Audience token is not set.", null, true);
    return o.token;
  };
  return {
    async send(events) {
      await post(f, `${o.url}/api/v1/events`, token(), { events }, "Audience");
    },
    async profile(email, now) {
      const found = await get(f, `${o.url}/api/v1/people?${new URLSearchParams({ email, limit: "1" })}`, token(), "Audience");
      const person = obj((obj(found.body)?.people as unknown[] | undefined)?.[0]);
      const id = str(person?.id, 200);
      if (!person || !id) return null;
      const ev = await get(f, `${o.url}/api/v1/people/${encodeURIComponent(id)}/events?limit=200`, token(), "Audience");
      const events = (Array.isArray(obj(ev.body)?.events) ? (obj(ev.body)!.events as unknown[]) : []).map(obj).filter((e): e is Record<string, unknown> => !!e);
      const since = now - 30 * 86_400_000;
      const views = new Map<string, number>();
      for (const e of events) {
        const path = str(obj(e.properties)?.path, 300);
        if (e.type === "page_viewed" && path && Date.parse(String(e.at)) >= since) views.set(path, (views.get(path) ?? 0) + 1);
      }
      const traits: ProfileSnippet["traits"] = {};
      for (const [k, v] of Object.entries(obj(person.traits) ?? {}))
        if (["string", "number", "boolean"].includes(typeof v)) traits[k] = v as string | number | boolean;
      return {
        id,
        pages: [...views]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 5)
          .map(([path, n]) => ({ path, views: n })),
        recent: events
          .filter((e) => e.source !== "crm" && e.type !== "page_viewed")
          .slice(0, 5)
          .map((e) => ({ at: String(e.at), source: String(e.source), type: String(e.type), text: str(e.text) })),
        traits,
      };
    },
  };
}

/** An event as Messages' POST /api/v1/events takes it (messages/openapi.json, EventBatch). */
export interface MessagesEvent {
  type: string;
  person: { email: string; name?: string; phone?: string; fields?: Record<string, string | number> };
}

export interface MessagesLink {
  send(events: MessagesEvent[]): Promise<void>;
}

export function messagesLink(o: { url: string; token: string | undefined; fetch?: typeof fetch }): MessagesLink {
  const f = o.fetch ?? fetch;
  return {
    async send(events) {
      if (!o.token) throw new LinkError("The Messages token is not set.", null, true);
      await post(f, `${o.url}/api/v1/events`, o.token, { events }, "Messages");
    },
  };
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
  close(): void;
}

export function smtpMailer(m: NonNullable<Config["mail"]>, password: string | undefined, o: { allowPlain?: boolean } = {}): Mailer {
  const t: Transporter = nodemailer.createTransport({
    host: m.host,
    port: m.port,
    secure: m.security === "tls",
    requireTLS: m.security === "starttls" && !o.allowPlain,
    ignoreTLS: m.security === "none",
    auth: m.user && password ? { user: m.user, pass: password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    async send(mail) {
      await t.sendMail({ from: m.from, to: mail.to, subject: mail.subject, text: mail.text, attachments: mail.attachments });
    },
    close: () => t.close(),
  };
}
