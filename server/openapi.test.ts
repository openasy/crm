import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI_TEXT } from "../scripts/openapi.ts";
import { ADMIN_TOKEN, connectCalendar, EMILY, startApp, type TestApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json, and every operation is called.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "crm-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: TestApp;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});
afterAll(() => app.close());

async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method, redirect: "manual" });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);
  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;
  if (!response.content) {
    await res.arrayBuffer();
    if (res.status !== 302) expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined as any };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();
  if (type === "application/pdf") return { res, body: Buffer.from(await res.arrayBuffer()) as any };
  const body = type.endsWith("json") ? await res.json() : await res.text();
  const validate = ajv.getSchema(`${at}/content/${type.replace("/", "~1")}/schema`)!;
  expect(validate(body), `${method} ${concrete}: ${JSON.stringify(validate.errors)}`).toBe(true);
  return { res, body: body as any };
}

const admin = (b?: unknown) => ({
  headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
  ...(b !== undefined && { body: typeof b === "string" ? b : JSON.stringify(b) }),
});
const anon = (b?: unknown) => ({ headers: { "content-type": "application/json" }, ...(b !== undefined && { body: JSON.stringify(b) }) });

describe("openapi.json", () => {
  it("is what scripts/openapi.ts writes, with the version of this release", () => {
    expect(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")).toBe(OPENAPI_TEXT);
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version and the sign-in routes", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    expect((await fetch(`${base}/api/docs/`)).headers.get("content-type")).toContain("text/html");
  });
});

describe("responses match openapi.json", () => {
  const ids: Record<string, string> = {};

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    for (const p of ["/api/v1/products", "/api/v1/summary", "/api/v1/settings", "/api/v1/team", "/api/v1/integrations", "/api/v1/meetings"]) {
      await call("GET", p, admin());
      await call("GET", p, {});
    }
    await call("GET", "/api/v1/report", admin());
    await call("GET", "/api/v1/report", admin(), "/api/v1/report?pipeline=nope");
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("companies and contacts", async () => {
    ids.company = (await call("POST", "/api/v1/companies", admin({ name: "Yıldız Mimarlık", city: "İzmir", plan: "business", users: 12 }))).body.id;
    await call("POST", "/api/v1/companies", admin({ name: "Yıldız Mimarlık" }));
    await call("POST", "/api/v1/companies", admin({ name: "" }));
    await call("POST", "/api/v1/companies", admin("{"));
    await call("GET", "/api/v1/companies", admin(), "/api/v1/companies?q=izmir");
    await call("GET", "/api/v1/companies/{id}", admin(), `/api/v1/companies/${ids.company}`);
    await call("GET", "/api/v1/companies/{id}", admin(), "/api/v1/companies/missing");
    await call("PATCH", "/api/v1/companies/{id}", admin({ sector: "Architecture" }), `/api/v1/companies/${ids.company}`);
    await call("PATCH", "/api/v1/companies/{id}", admin({ plan: "gold" }), `/api/v1/companies/${ids.company}`);
    await call("PATCH", "/api/v1/companies/{id}", admin({}), "/api/v1/companies/missing");
    const other = (await call("POST", "/api/v1/companies", admin({ name: "Other Co" }))).body.id;
    await call("PATCH", "/api/v1/companies/{id}", admin({ name: "Yıldız Mimarlık" }), `/api/v1/companies/${other}`);

    ids.contact = (await call("POST", "/api/v1/contacts", admin({ name: "Hakan Yıldız", email: "hakan@yildiz.example", company: ids.company }))).body.id;
    await call("POST", "/api/v1/contacts", admin({ name: "Again", email: "hakan@yildiz.example" }));
    await call("POST", "/api/v1/contacts", admin({ name: "X", company: "missing" }));
    await call("POST", "/api/v1/contacts", admin({ name: "X", email: "not-an-email" }));
    await call("GET", "/api/v1/contacts", admin(), "/api/v1/contacts?q=hakan");
    await call("GET", "/api/v1/contacts/{id}", admin(), `/api/v1/contacts/${ids.contact}`);
    await call("GET", "/api/v1/contacts/{id}", admin(), "/api/v1/contacts/missing");
    await call("PATCH", "/api/v1/contacts/{id}", admin({ title: "Founder" }), `/api/v1/contacts/${ids.contact}`);
    await call("PATCH", "/api/v1/contacts/{id}", admin({ phone: "x" }), `/api/v1/contacts/${ids.contact}`);
    await call("PATCH", "/api/v1/contacts/{id}", admin({}), "/api/v1/contacts/missing");
    const twin = (await call("POST", "/api/v1/contacts", admin({ name: "Twin" }))).body.id;
    await call("PATCH", "/api/v1/contacts/{id}", admin({ email: "hakan@yildiz.example" }), `/api/v1/contacts/${twin}`);
  });

  it("deals", async () => {
    ids.deal = (
      await call(
        "POST",
        "/api/v1/deals",
        admin({ name: "3-year agreement", value: 210000, contact: ids.contact, stage: "negotiation", expectedClose: "2026-11-28", owner: EMILY.id }),
      )
    ).body.id;
    await call("POST", "/api/v1/deals", admin({ name: "x", stage: "nope" }));
    await call("POST", "/api/v1/deals", admin({ name: "x", contact: "missing" }));
    await call("POST", "/api/v1/deals", admin("{"));
    await call("GET", "/api/v1/deals", admin(), "/api/v1/deals?status=all&q=agreement");
    await call("GET", "/api/v1/deals", admin(), "/api/v1/deals?status=maybe");
    await call("GET", "/api/v1/deals/{id}", admin(), `/api/v1/deals/${ids.deal}`);
    await call("GET", "/api/v1/deals/{id}", admin(), "/api/v1/deals/missing");
    await call("PATCH", "/api/v1/deals/{id}", admin({ value: 220000 }), `/api/v1/deals/${ids.deal}`);
    await call("PATCH", "/api/v1/deals/{id}", admin({ value: -1 }), `/api/v1/deals/${ids.deal}`);
    await call("PATCH", "/api/v1/deals/{id}", admin({}), "/api/v1/deals/missing");
    await call("POST", "/api/v1/deals/{id}/move", admin({ stage: "proposal" }), `/api/v1/deals/${ids.deal}/move`);
    await call("POST", "/api/v1/deals/{id}/move", admin({ stage: "nope" }), `/api/v1/deals/${ids.deal}/move`);
    await call("POST", "/api/v1/deals/{id}/move", admin({ stage: "lead" }), "/api/v1/deals/missing/move");
    await call("GET", "/api/v1/deals/{id}/audience", admin(), `/api/v1/deals/${ids.deal}/audience`);
    await call("GET", "/api/v1/deals/{id}/audience", admin(), "/api/v1/deals/missing/audience");
    app.fakes.state.audience.status = 200;
    await call("POST", "/api/v1/deals/{id}/sequences", admin({ sequence: "follow-up" }), `/api/v1/deals/${ids.deal}/sequences`);
    await call("POST", "/api/v1/deals/{id}/sequences", admin({ sequence: "nope" }), `/api/v1/deals/${ids.deal}/sequences`);
    await call("POST", "/api/v1/deals/{id}/sequences", admin({ sequence: "follow-up" }), "/api/v1/deals/missing/sequences");
    const bare = (await call("POST", "/api/v1/deals", admin({ name: "No contact" }))).body.id;
    await call("POST", "/api/v1/deals/{id}/sequences", admin({ sequence: "follow-up" }), `/api/v1/deals/${bare}/sequences`);
    await call("POST", "/api/v1/deals/{id}/lost", admin({}), `/api/v1/deals/${bare}/lost`);
    await call("POST", "/api/v1/deals/{id}/lost", admin({ reason: "Not this year" }), `/api/v1/deals/${bare}/lost`);
    await call("POST", "/api/v1/deals/{id}/lost", admin({ reason: "Not this year" }), `/api/v1/deals/${bare}/lost`);
    await call("POST", "/api/v1/deals/{id}/lost", admin({ reason: "x" }), "/api/v1/deals/missing/lost");
    await call("POST", "/api/v1/deals/{id}/move", admin({ stage: "lead" }), `/api/v1/deals/${bare}/move`);
    await call("POST", "/api/v1/deals/{id}/reopen", admin({}), `/api/v1/deals/${bare}/reopen`);
    await call("POST", "/api/v1/deals/{id}/reopen", admin({}), `/api/v1/deals/${bare}/reopen`);
    await call("POST", "/api/v1/deals/{id}/reopen", admin({ stage: "nope" }), `/api/v1/deals/${bare}/reopen`);
    await call("POST", "/api/v1/deals/{id}/reopen", admin({}), "/api/v1/deals/missing/reopen");
    await call("POST", "/api/v1/deals/{id}/won", admin({ value: 1000 }), `/api/v1/deals/${bare}/won`);
    await call("POST", "/api/v1/deals/{id}/won", admin({}), `/api/v1/deals/${bare}/won`);
    await call("POST", "/api/v1/deals/{id}/won", admin({ value: "x" }), "/api/v1/deals/missing/won");
    const wonX = (await call("POST", "/api/v1/deals", admin({ name: "Bad value" }))).body.id;
    await call("POST", "/api/v1/deals/{id}/won", admin({ value: "x" }), `/api/v1/deals/${wonX}/won`);
    await call("DELETE", "/api/v1/deals/{id}", admin(), `/api/v1/deals/${wonX}`);
    await call("DELETE", "/api/v1/deals/{id}", admin(), `/api/v1/deals/${wonX}`);
    await call("GET", "/api/v1/deals", {});
  });

  it("activities and tasks", async () => {
    const a = (await call("POST", "/api/v1/activities", admin({ kind: "call", text: "Agreed on the 3-year price", deal: ids.deal }))).body.id;
    await call("POST", "/api/v1/activities", admin({ kind: "fax", text: "x", deal: ids.deal }));
    await call("POST", "/api/v1/activities", admin({ kind: "note", text: "x", deal: "missing" }));
    await call("POST", "/api/v1/activities", admin("{"));
    await call("GET", "/api/v1/activities", admin(), `/api/v1/activities?deal=${ids.deal}`);
    await call("DELETE", "/api/v1/activities/{id}", admin(), `/api/v1/activities/${a}`);
    await call("DELETE", "/api/v1/activities/{id}", admin(), `/api/v1/activities/${a}`);
    const system = app.crm.getDeal(EMILY, ids.deal!).activities.find((x) => x.kind === "system")!.id;
    await call("DELETE", "/api/v1/activities/{id}", admin(), `/api/v1/activities/${system}`);

    const t = (await call("POST", "/api/v1/tasks", admin({ text: "Send the contract", due: "2026-11-10", deal: ids.deal }))).body.id;
    await call("POST", "/api/v1/tasks", admin({ text: "x", due: "tomorrow" }));
    await call("POST", "/api/v1/tasks", admin({ text: "x", due: "2026-11-10", deal: "missing" }));
    await call("GET", "/api/v1/tasks", admin(), "/api/v1/tasks?owner=all");
    await call("GET", "/api/v1/tasks", admin(), "/api/v1/tasks?state=maybe");
    await call("PATCH", "/api/v1/tasks/{id}", admin({ done: true }), `/api/v1/tasks/${t}`);
    await call("PATCH", "/api/v1/tasks/{id}", admin({ done: "yes" }), `/api/v1/tasks/${t}`);
    await call("PATCH", "/api/v1/tasks/{id}", admin({}), "/api/v1/tasks/missing");
    await call("DELETE", "/api/v1/tasks/{id}", admin(), `/api/v1/tasks/${t}`);
    await call("DELETE", "/api/v1/tasks/{id}", admin(), `/api/v1/tasks/${t}`);
  });

  it("quotes", async () => {
    const q = (
      await call(
        "POST",
        "/api/v1/deals/{id}/quotes",
        admin({ lines: [{ item: "Pro, 6 kullanıcı", quantity: 6, unitPrice: 9000 }] }),
        `/api/v1/deals/${ids.deal}/quotes`,
      )
    ).body.id;
    await call("POST", "/api/v1/deals/{id}/quotes", admin({ lines: [] }), `/api/v1/deals/${ids.deal}/quotes`);
    await call("POST", "/api/v1/deals/{id}/quotes", admin({}), "/api/v1/deals/missing/quotes");
    await call("GET", "/api/v1/quotes/{id}", admin(), `/api/v1/quotes/${q}`);
    await call("GET", "/api/v1/quotes/{id}", admin(), "/api/v1/quotes/missing");
    await call("PATCH", "/api/v1/quotes/{id}", admin({ notes: "3 yıllık fiyat" }), `/api/v1/quotes/${q}`);
    await call("PATCH", "/api/v1/quotes/{id}", admin({ lines: [{ item: "x", unitPrice: -1 }] }), `/api/v1/quotes/${q}`);
    await call("PATCH", "/api/v1/quotes/{id}", admin({}), "/api/v1/quotes/missing");
    const pdf = await call("GET", "/api/v1/quotes/{id}/pdf", admin(), `/api/v1/quotes/${q}/pdf`);
    expect(pdf.res.headers.get("content-disposition")).toMatch(/^attachment; filename="Q-2026-\d{3}\.pdf"$/);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    await call("GET", "/api/v1/quotes/{id}/pdf", admin(), "/api/v1/quotes/missing/pdf");
    await call("POST", "/api/v1/quotes/{id}/accept", admin(), `/api/v1/quotes/${q}/accept`);
    await call("POST", "/api/v1/quotes/{id}/send", admin({ email: "yes" }), `/api/v1/quotes/${q}/send`);
    app.mailer.fail = true;
    await call("POST", "/api/v1/quotes/{id}/send", admin({ email: true }), `/api/v1/quotes/${q}/send`);
    app.mailer.fail = false;
    await call("POST", "/api/v1/quotes/{id}/send", admin({ email: true }), `/api/v1/quotes/${q}/send`);
    await call("POST", "/api/v1/quotes/{id}/send", admin({}), `/api/v1/quotes/${q}/send`);
    await call("POST", "/api/v1/quotes/{id}/send", admin({}), "/api/v1/quotes/missing/send");
    await call("PATCH", "/api/v1/quotes/{id}", admin({ notes: "x" }), `/api/v1/quotes/${q}`);
    await call("DELETE", "/api/v1/quotes/{id}", admin(), `/api/v1/quotes/${q}`);
    await call("POST", "/api/v1/quotes/{id}/decline", admin(), `/api/v1/quotes/${q}/decline`);
    await call("POST", "/api/v1/quotes/{id}/decline", admin(), `/api/v1/quotes/${q}/decline`);
    await call("POST", "/api/v1/quotes/{id}/decline", admin(), "/api/v1/quotes/missing/decline");
    await call("POST", "/api/v1/quotes/{id}/accept", admin(), "/api/v1/quotes/missing/accept");
    const d2 = (await call("POST", "/api/v1/deals", admin({ name: "Second" }))).body.id;
    const q2 = (await call("POST", "/api/v1/deals/{id}/quotes", admin({}), `/api/v1/deals/${d2}/quotes`)).body.id;
    await call("DELETE", "/api/v1/quotes/{id}", admin(), `/api/v1/quotes/${q2}`);
    await call("DELETE", "/api/v1/quotes/{id}", admin(), `/api/v1/quotes/${q2}`);
  });

  it("import", async () => {
    await call("POST", "/api/v1/import", admin({ kind: "contacts", csv: "name,email\nSeda Polat,seda@polat.example\n", dryRun: true }));
    await call("POST", "/api/v1/import", admin({ kind: "invoices", csv: "x" }));
    await call("POST", "/api/v1/import", { ...admin(), body: JSON.stringify({ kind: "deals", csv: "x".repeat(9 * 1024 * 1024) }) });
  });

  it("meetings, calendars and booking", async () => {
    await call("GET", "/api/v1/calendar", admin());
    await call("POST", "/api/v1/calendar/connect", admin({ provider: "google" }));
    await call("POST", "/api/v1/calendar/connect", admin({ provider: "yahoo" }));
    await call("GET", "/api/v1/calendar/callback", admin(), "/api/v1/calendar/callback?state=x&code=y");
    await call("DELETE", "/api/v1/calendar", admin());
    await call("GET", "/api/v1/public/meetings/{id}", {}, "/api/v1/public/meetings/demo");
    await call("GET", "/api/v1/public/meetings/{id}", {}, "/api/v1/public/meetings/nope");
    await connectCalendar(app, EMILY, "google", "emily@example.com");
    const slots = (await call("GET", "/api/v1/public/meetings/{id}", {}, "/api/v1/public/meetings/demo")).body.slots as Array<{ start: string }>;
    const made = await call(
      "POST",
      "/api/v1/public/meetings/{id}/bookings",
      anon({ start: slots[0]!.start, name: "Elif Kaya", email: "elif@kaya.example", company: "Kaya Eczane" }),
      "/api/v1/public/meetings/demo/bookings",
    );
    expect(made.res.headers.get("access-control-allow-origin")).toBe("*");
    await call(
      "POST",
      "/api/v1/public/meetings/{id}/bookings",
      anon({ start: slots[0]!.start, name: "Again", email: "again@example.com" }),
      "/api/v1/public/meetings/demo/bookings",
    );
    await call("POST", "/api/v1/public/meetings/{id}/bookings", anon({ start: slots[1]!.start, name: "No email" }), "/api/v1/public/meetings/demo/bookings");
    await call(
      "POST",
      "/api/v1/public/meetings/{id}/bookings",
      { headers: { "content-type": "application/json" }, body: "{" },
      "/api/v1/public/meetings/demo/bookings",
    );
    await call(
      "POST",
      "/api/v1/public/meetings/{id}/bookings",
      anon({ start: slots[1]!.start, name: "X", email: "x@example.com" }),
      "/api/v1/public/meetings/nope/bookings",
    );
    app.fakes.state.failCreate = 500;
    await call(
      "POST",
      "/api/v1/public/meetings/{id}/bookings",
      anon({ start: slots[2]!.start, name: "Fails", email: "fails@example.com" }),
      "/api/v1/public/meetings/demo/bookings",
    );
    await call("GET", "/api/v1/bookings", admin(), "/api/v1/bookings?link=demo");
    await call("POST", "/api/v1/bookings/{id}/cancel", admin(), `/api/v1/bookings/${made.body.booking.id}/cancel`);
    await call("POST", "/api/v1/bookings/{id}/cancel", admin(), `/api/v1/bookings/${made.body.booking.id}/cancel`);
    await call("POST", "/api/v1/bookings/{id}/cancel", admin(), "/api/v1/bookings/missing/cancel");
    const b2 = await call(
      "POST",
      "/api/v1/public/meetings/{id}/bookings",
      anon({ start: slots[3]!.start, name: "Kept", email: "kept@example.com" }),
      "/api/v1/public/meetings/demo/bookings",
    );
    app.fakes.revoke();
    app.db.prepare("UPDATE calendar_accounts SET expires_at = ?").run(new Date(0).toISOString());
    await call("POST", "/api/v1/bookings/{id}/cancel", admin(), `/api/v1/bookings/${b2.body.booking.id}/cancel`);
    app.clock.advance(2 * 60_000);
    await call("GET", "/api/v1/public/meetings/{id}", {}, "/api/v1/public/meetings/demo");
    // The booking page itself.
    const page = await fetch(`${base}/book/intro?lang=tr`);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("Bu bağlantıdan şu anda randevu alınamıyor.");
    for (let i = 0; i < 11; i++) await fetch(`${base}/api/v1/public/meetings/demo/bookings`, { method: "POST", body: "{}" });
    await call("POST", "/api/v1/public/meetings/{id}/bookings", anon({}), "/api/v1/public/meetings/demo/bookings");
    for (let i = 0; i < 60; i++) await fetch(`${base}/api/v1/public/meetings/demo`);
    await call("GET", "/api/v1/public/meetings/{id}", {}, "/api/v1/public/meetings/demo");
  });

  it("what other products call", async () => {
    await call("GET", "/api/v1/lookup", admin(), "/api/v1/lookup?email=hakan@yildiz.example");
    await call("GET", "/api/v1/lookup", admin(), "/api/v1/lookup?email=nobody@example.com");
    await call("GET", "/api/v1/lookup", admin(), "/api/v1/lookup?email=x");
    await call("GET", "/api/v1/lookup", {}, "/api/v1/lookup?email=x@example.com");
    const lead = {
      external_id: "form-1",
      source: "forms",
      name: "Kerem Aksoy",
      email: "kerem@aksoy.example",
      title: "Demo request",
      company: "Aksoy Danışmanlık",
    };
    await call("POST", "/api/v1/leads", admin(lead));
    await call("POST", "/api/v1/leads", admin(lead));
    await call("POST", "/api/v1/leads", admin({ title: "no id" }));
    await call("POST", "/api/v1/leads", admin("{"));
    await call(
      "POST",
      "/api/v1/erasures",
      admin({ reference: "KVKK-1", product: "audience", people: { emails: ["kerem@aksoy.example"], phones: [], userIds: [] } }),
    );
    await call("POST", "/api/v1/erasures", admin({ reference: "KVKK-2", product: "audience" }));
    await call("POST", "/api/v1/erasures", anon({}));
  });

  it("deleting", async () => {
    await call("DELETE", "/api/v1/contacts/{id}", admin(), `/api/v1/contacts/${ids.contact}`);
    await call("DELETE", "/api/v1/contacts/{id}", admin(), `/api/v1/contacts/${ids.contact}`);
    await call("DELETE", "/api/v1/companies/{id}", admin(), `/api/v1/companies/${ids.company}`);
    await call("DELETE", "/api/v1/companies/{id}", admin(), `/api/v1/companies/${ids.company}`);
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
