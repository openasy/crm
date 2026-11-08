import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import { bookFromForm, bookingPage, pickLang } from "./book.ts";
import type { Crm } from "./crm.ts";
import { log } from "./log.ts";
import type { Meetings } from "./meetings.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";
import { CrmError, type Actor, type ProblemCode } from "./store.ts";

export interface AppOptions {
  db: DatabaseSync;
  crm: Crm;
  meetings: Meetings;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** #rrggbb from the install's brand, for the booking page. */
  accent?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

function metricsText(crm: Crm, version: string) {
  return renderMetrics(version, { ...crm.gauges(), fileError: !!crm.settings().file?.error });
}

/** Serves only /metrics, for a port that is not exposed with the rest (CRM_METRICS_PORT). */
export function createMetricsHandler(crm: Crm, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(crm, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

/** The pages run nothing from elsewhere. */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'`,
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) =>
  send(res, status, JSON.stringify(data), "application/json", headers);

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  forbidden: "Forbidden",
  "not-found": "Not found",
  conflict: "Conflict",
  "not-linked": "Not linked",
  "not-available": "Not available",
  "link-failed": "Another service failed",
  "rate-limited": "Too many requests",
  "payload-too-large": "Payload too large",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string, headers: Record<string, string> = {}) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json", headers);
}

async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  // A body too large is read to its end and dropped, so the answer reaches a client still sending and the
  // connection stays usable; past four times the limit the connection is cut.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 4 * limit) {
      req.destroy();
      break;
    }
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw new CrmError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024)} KiB.`);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const text = await readBody(req, limit);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new CrmError(400, "invalid-json", "The body must be JSON.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The role a route needs (ADR 0003); "none" for the version and the booking API, which anyone may call. */
type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  who: Actor;
  body: () => Promise<unknown>;
}
interface Route {
  method: string;
  path: string;
  auth: Access;
  limit?: number;
  /** Calls a minute from one address, for routes anyone may call. */
  rate?: number;
  handle: (ctx: Ctx) => unknown;
}

export function createApp({
  db,
  crm,
  meetings,
  version,
  auth,
  adminToken,
  accent = "#2f5bd3",
  webDir,
  docsDir,
  openapi,
  serveMetrics = true,
  products = [],
}: AppOptions) {
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };
  const created = (res: ServerResponse, data: unknown) => json(res, 201, data);
  const P = "/api/v1";
  const PUBLIC_CORS = { "access-control-allow-origin": "*", vary: "Origin" };

  const routes: Route[] = [
    { method: "GET", path: `${P}/version`, auth: "none", handle: () => ({ product: "crm", version }) },
    { method: "GET", path: `${P}/products`, auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: `${P}/summary`, auth: "viewer", handle: ({ who }) => crm.summary(who) },
    // The settings, as the file sets them. There is no route that changes them.
    { method: "GET", path: `${P}/settings`, auth: "viewer", handle: () => crm.settings() },
    { method: "GET", path: `${P}/team`, auth: "viewer", handle: () => ({ members: crm.team().map(({ id, name, email }) => ({ id, name, email })) }) },
    { method: "GET", path: `${P}/integrations`, auth: "viewer", handle: () => crm.integrations() },
    { method: "GET", path: `${P}/report`, auth: "viewer", handle: ({ who, url }) => crm.report(who, url.searchParams) },

    { method: "GET", path: `${P}/companies`, auth: "viewer", handle: ({ who, url }) => ({ companies: crm.listCompanies(who, url.searchParams) }) },
    { method: "POST", path: `${P}/companies`, auth: "editor", handle: async ({ res, who, body }) => created(res, crm.createCompany(who, await body())) },
    { method: "GET", path: `${P}/companies/:id`, auth: "viewer", handle: ({ who, params }) => crm.getCompany(who, params[0]!) },
    { method: "PATCH", path: `${P}/companies/:id`, auth: "editor", handle: async ({ who, params, body }) => crm.updateCompany(who, params[0]!, await body()) },
    { method: "DELETE", path: `${P}/companies/:id`, auth: "editor", handle: ({ res, who, params }) => (crm.removeCompany(who, params[0]!), noContent(res)) },

    { method: "GET", path: `${P}/contacts`, auth: "viewer", handle: ({ who, url }) => ({ contacts: crm.listContacts(who, url.searchParams) }) },
    { method: "POST", path: `${P}/contacts`, auth: "editor", handle: async ({ res, who, body }) => created(res, crm.createContact(who, await body())) },
    { method: "GET", path: `${P}/contacts/:id`, auth: "viewer", handle: ({ who, params }) => crm.getContact(who, params[0]!) },
    { method: "PATCH", path: `${P}/contacts/:id`, auth: "editor", handle: async ({ who, params, body }) => crm.updateContact(who, params[0]!, await body()) },
    { method: "DELETE", path: `${P}/contacts/:id`, auth: "editor", handle: ({ res, who, params }) => (crm.removeContact(who, params[0]!), noContent(res)) },

    { method: "GET", path: `${P}/deals`, auth: "viewer", handle: ({ who, url }) => ({ deals: crm.listDeals(who, url.searchParams) }) },
    {
      method: "POST",
      path: `${P}/deals`,
      auth: "editor",
      handle: async ({ res, who, body }) => created(res, crm.createDeal(who, await body(), who.id.startsWith("token:") ? "api" : "manual")),
    },
    { method: "GET", path: `${P}/deals/:id`, auth: "viewer", handle: ({ who, params }) => crm.getDeal(who, params[0]!) },
    { method: "PATCH", path: `${P}/deals/:id`, auth: "editor", handle: async ({ who, params, body }) => crm.updateDeal(who, params[0]!, await body()) },
    { method: "DELETE", path: `${P}/deals/:id`, auth: "editor", handle: ({ res, who, params }) => (crm.removeDeal(who, params[0]!), noContent(res)) },
    { method: "POST", path: `${P}/deals/:id/move`, auth: "editor", handle: async ({ who, params, body }) => crm.moveDeal(who, params[0]!, await body()) },
    {
      method: "POST",
      path: `${P}/deals/:id/won`,
      auth: "editor",
      handle: async ({ who, params, body }) => crm.closeDeal(who, params[0]!, await body(), "won"),
    },
    {
      method: "POST",
      path: `${P}/deals/:id/lost`,
      auth: "editor",
      handle: async ({ who, params, body }) => crm.closeDeal(who, params[0]!, await body(), "lost"),
    },
    { method: "POST", path: `${P}/deals/:id/reopen`, auth: "editor", handle: async ({ who, params, body }) => crm.reopenDeal(who, params[0]!, await body()) },
    {
      method: "POST",
      path: `${P}/deals/:id/quotes`,
      auth: "editor",
      handle: async ({ res, who, params, body }) => created(res, crm.createQuote(who, params[0]!, await body())),
    },
    {
      method: "POST",
      path: `${P}/deals/:id/sequences`,
      auth: "editor",
      handle: async ({ res, who, params, body }) => json(res, 202, crm.startSequence(who, params[0]!, await body())),
    },
    { method: "GET", path: `${P}/deals/:id/audience`, auth: "viewer", handle: ({ params }) => crm.audienceProfile(params[0]!) },

    {
      method: "GET",
      path: `${P}/activities`,
      auth: "viewer",
      handle: ({ url }) => ({
        activities: crm.listActivities({
          deal: url.searchParams.get("deal") ?? undefined,
          contact: url.searchParams.get("contact") ?? undefined,
          company: url.searchParams.get("company") ?? undefined,
        }),
      }),
    },
    { method: "POST", path: `${P}/activities`, auth: "editor", handle: async ({ res, who, body }) => created(res, crm.logActivity(who, await body())) },
    { method: "DELETE", path: `${P}/activities/:id`, auth: "editor", handle: ({ res, who, params }) => (crm.removeActivity(who, params[0]!), noContent(res)) },

    { method: "GET", path: `${P}/tasks`, auth: "viewer", handle: ({ who, url }) => ({ tasks: crm.listTasks(who, url.searchParams) }) },
    { method: "POST", path: `${P}/tasks`, auth: "editor", handle: async ({ res, who, body }) => created(res, crm.createTask(who, await body())) },
    { method: "PATCH", path: `${P}/tasks/:id`, auth: "editor", handle: async ({ who, params, body }) => crm.updateTask(who, params[0]!, await body()) },
    { method: "DELETE", path: `${P}/tasks/:id`, auth: "editor", handle: ({ res, who, params }) => (crm.removeTask(who, params[0]!), noContent(res)) },

    { method: "GET", path: `${P}/quotes/:id`, auth: "viewer", handle: ({ params }) => crm.getQuote(params[0]!) },
    { method: "PATCH", path: `${P}/quotes/:id`, auth: "editor", handle: async ({ who, params, body }) => crm.updateQuote(who, params[0]!, await body()) },
    { method: "DELETE", path: `${P}/quotes/:id`, auth: "editor", handle: ({ res, who, params }) => (crm.removeQuote(who, params[0]!), noContent(res)) },
    { method: "POST", path: `${P}/quotes/:id/send`, auth: "editor", handle: async ({ who, params, body }) => crm.sendQuote(who, params[0]!, await body()) },
    { method: "POST", path: `${P}/quotes/:id/accept`, auth: "editor", handle: ({ who, params }) => crm.decideQuote(who, params[0]!, "accepted") },
    { method: "POST", path: `${P}/quotes/:id/decline`, auth: "editor", handle: ({ who, params }) => crm.decideQuote(who, params[0]!, "declined") },
    {
      method: "GET",
      path: `${P}/quotes/:id/pdf`,
      auth: "viewer",
      handle: async ({ res, params }) => {
        const f = await crm.quoteFile(params[0]!);
        send(res, 200, f.pdf, "application/pdf", { "content-disposition": `attachment; filename="${f.filename}"`, "cache-control": "no-store" });
      },
    },

    { method: "POST", path: `${P}/import`, auth: "editor", limit: 8 * 1024 * 1024, handle: async ({ who, body }) => crm.importCsv(who, await body()) },

    { method: "GET", path: `${P}/meetings`, auth: "viewer", handle: () => ({ links: meetings.links() }) },
    { method: "GET", path: `${P}/bookings`, auth: "viewer", handle: ({ url }) => ({ bookings: meetings.bookings(url.searchParams) }) },
    { method: "POST", path: `${P}/bookings/:id/cancel`, auth: "editor", handle: ({ who, params }) => meetings.cancel(who, params[0]!) },
    { method: "GET", path: `${P}/calendar`, auth: "viewer", handle: ({ who }) => meetings.calendarState(who) },
    { method: "POST", path: `${P}/calendar/connect`, auth: "viewer", handle: async ({ who, body }) => meetings.connect(who, await body()) },
    { method: "DELETE", path: `${P}/calendar`, auth: "viewer", handle: ({ res, who }) => (meetings.disconnect(who), noContent(res)) },

    // What anyone may call: the booking page's free times and the booking itself.
    {
      method: "GET",
      path: `${P}/public/meetings/:id`,
      auth: "none",
      rate: 60,
      handle: async ({ res, params }) => json(res, 200, await meetings.publicSlots(params[0]!), PUBLIC_CORS),
    },
    {
      method: "POST",
      path: `${P}/public/meetings/:id/bookings`,
      auth: "none",
      rate: 10,
      limit: 16 * 1024,
      handle: async ({ res, params, body }) => json(res, 201, await meetings.book(params[0]!, await body()), PUBLIC_CORS),
    },

    // What other products call.
    { method: "GET", path: `${P}/lookup`, auth: "viewer", handle: ({ url }) => crm.lookup(url.searchParams.get("email")) },
    {
      method: "POST",
      path: `${P}/leads`,
      auth: "editor",
      handle: async ({ res, who, body }) => {
        const r = crm.openLead(who, await body());
        json(res, r.status, r.body);
      },
    },
    { method: "POST", path: `${P}/erasures`, auth: "admin", handle: async ({ body }) => crm.erase(await body()) },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  const hits = new Map<string, { minute: number; n: number }>();
  function limited(req: IncomingMessage, route: string, rate: number): boolean {
    const key = `${route}|${req.socket.remoteAddress ?? ""}`;
    const minute = Math.floor(Date.now() / 60_000);
    const h = hits.get(key);
    if (!h || h.minute !== minute) {
      if (hits.size > 10_000) hits.clear();
      hits.set(key, { minute, n: 1 });
      return false;
    }
    return ++h.n > rate;
  }

  function authorize(req: IncomingMessage, access: Access): Actor {
    if (access === "none") return { id: "anonymous", name: "Anonymous", role: "viewer" };
    if (tokenMatches(req.headers.authorization, adminToken)) return { id: "admin-token", name: "Admin token", role: "admin" };
    const p = auth.authorize(req, access);
    return p.kind === "session" ? { id: p.user.id, name: p.user.name, role: p.role } : { id: `token:${p.tokenId}`, name: p.name, role: p.role };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");
    if (path === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        if (!crm.config()) throw new Error("no settings");
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "not ready" });
      }
      return "/readyz";
    }
    if (path === "/metrics") {
      if (serveMetrics) send(res, 200, metricsText(crm, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }
    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");
    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      if (!(await serveFile(res, docsDir, path.slice("/api/docs/".length) || "index.html"))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    // The booking page, for anyone with the link.
    const book = /^\/book\/([a-z0-9-]+)$/.exec(path);
    if (book && (req.method === "GET" || req.method === "POST")) {
      const lang = pickLang(req, url);
      if (limited(req, "/book", req.method === "POST" ? 10 : 60)) {
        send(res, 429, "Too many requests from this address; wait a minute.", "text/plain; charset=utf-8", { "retry-after": "60" });
        return "/book/:id";
      }
      try {
        const r =
          req.method === "GET"
            ? await bookingPage(meetings, book[1]!, lang, accent)
            : await bookFromForm(meetings, book[1]!, lang, accent, new URLSearchParams(await readBody(req, 16 * 1024)));
        send(res, r.status, r.html, TYPES[".html"], { "cache-control": "no-store" });
      } catch (err) {
        if (!(err instanceof CrmError)) throw err;
        send(res, err.status, err.message, "text/plain; charset=utf-8");
        if (!req.complete) req.resume();
      }
      return "/book/:id";
    }

    // The provider sends the browser back here after the person allowed CRM in their calendar.
    if (path === `${P}/calendar/callback` && req.method === "GET") {
      let to = "/meetings?calendar=expired";
      try {
        to = await meetings.callback(authorize(req, "viewer"), url);
      } catch (err) {
        if (!(err instanceof AuthError) && !(err instanceof CrmError)) throw err;
      }
      res.writeHead(302, { ...SECURITY_HEADERS, location: to }).end();
      return `${P}/calendar/callback`;
    }

    if (path.startsWith(`${P}/public/`) && req.method === "OPTIONS") {
      res
        .writeHead(204, {
          ...PUBLIC_CORS,
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "600",
        })
        .end();
      return `${P}/public/*`;
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      const cors = r.path.startsWith(`${P}/public/`) ? PUBLIC_CORS : {};
      try {
        if (r.rate && limited(req, r.path, r.rate)) throw new CrmError(429, "rate-limited", "Too many requests from this address; wait a minute.", 60);
        const who = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, who, body: () => readJson(req, r.limit ?? 1024 * 1024) });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof CrmError)) throw err;
        problem(res, err.status, err.code, err.message, { ...cors, ...(err.retryAfter ? { "retry-after": String(err.retryAfter) } : {}) });
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url?.split("?")[0] });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    // The lookup carries a customer's email in its query; only the path is logged.
    if (!["/healthz", "/metrics"].includes(routeName)) {
      log("info", "request", { method: req.method, path: (req.url ?? "/").split("?")[0], status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}
