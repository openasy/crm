// What other products call, as they call it: Helpdesk's lookup (helpdesk/server/links.ts, CrmLookup), Live Chat's
// leads (live-chat/server/links.ts, CrmLeadRequest and CrmLeadCreated) and Audience's erasures (its erasure webhook).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMILY, startApp, type TestApp } from "./test-app.ts";

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

describe("Helpdesk: GET /api/v1/lookup?email=", () => {
  it("answers the contact, their company's plan, owner and deals", async () => {
    const co = app.crm.createCompany(EMILY, { name: "Avcı Lojistik", plan: "business", planRenews: "2026-12-31", users: 48 });
    const ct = app.crm.createContact(EMILY, { name: "Gizem Avcı", email: "gizem@avci.example", title: "Finance lead", company: co.id });
    const d = app.crm.createDeal(EMILY, { name: "Renewal and 20 more users", value: 300000, contact: ct.id, stage: "proposal" });
    const res = await app.admin(`/api/v1/lookup?${new URLSearchParams({ email: "GIZEM@avci.example" })}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      contact: {
        id: ct.id,
        name: "Gizem Avcı",
        email: "gizem@avci.example",
        title: "Finance lead",
        company: { name: "Avcı Lojistik", users: 48 },
        plan: { id: "business", name: "Business", renews: "2026-12-31" },
        owner: { name: "Emily Clark", email: "emily@example.com" },
        url: `${app.base}/contacts/${ct.id}`,
      },
      deals: [
        { id: d.id, name: "Renewal and 20 more users", amount: 300000, currency: "TRY", stage: "Proposal", status: "open", url: `${app.base}/deals/${d.id}` },
      ],
    });
  });

  it("answers 404 for an address no contact has, matched exactly", async () => {
    expect((await app.admin("/api/v1/lookup?email=gizem@avci.example.com")).status).toBe(404);
    expect((await app.admin("/api/v1/lookup?email=avci.example")).status).toBe(422);
    expect((await fetch(`${app.base}/api/v1/lookup?email=gizem@avci.example`)).status).toBe(401);
  });
});

describe("Live Chat: POST /api/v1/leads", () => {
  // Exactly what live-chat/server/livechat.ts makeLead sends.
  const lead = {
    external_id: "live-chat-7c1e",
    source: "live-chat",
    name: "Nihan Er",
    email: "nihan@er-turizm.example",
    page: "https://www.example.com/pricing",
    title: "Do you have a plan for 5 users?",
    owner: { name: "Burak Şahin", email: "emily@example.com" },
    referrer: "https://www.google.com/",
    utm: { source: "google", medium: "cpc", campaign: "kis-2026" },
    pages: [
      { at: "2026-11-02T05:50:00Z", path: "/" },
      { at: "2026-11-02T05:52:00Z", path: "/pricing" },
    ],
    transcript: [
      { from: "visitor", name: "Nihan Er", at: "2026-11-02T05:53:00Z", text: "Do you have a plan for 5 users?" },
      { from: "agent", name: "Burak Şahin", at: "2026-11-02T05:54:00Z", text: "Yes, Pro. I will open a lead." },
    ],
    chat_url: "https://chat.example.com/chats/12",
  };

  it("opens a deal in leads.stage with the contact, once per external_id", async () => {
    const first = await app.admin("/api/v1/leads", { method: "POST", body: JSON.stringify(lead) });
    expect(first.status).toBe(201);
    const a = (await first.json()) as { lead: { id: string; url: string; contact: string } };
    expect(a.lead.url).toBe(`${app.base}/deals/${a.lead.id}`);
    const again = await app.admin("/api/v1/leads", { method: "POST", body: JSON.stringify(lead) });
    expect(again.status).toBe(200);
    expect(((await again.json()) as typeof a).lead.id).toBe(a.lead.id);

    const d = app.crm.getDeal(EMILY, a.lead.id);
    expect(d).toMatchObject({
      name: "Do you have a plan for 5 users?",
      stage: { id: "lead" },
      source: "live-chat",
      sourceDetail: "kis-2026",
      owner: { id: EMILY.id },
      contact: { email: "nihan@er-turizm.example" },
    });
    expect(d.activities[0]!.text).toContain("Read: /, /pricing");
    expect(d.activities[0]!.text).toContain("Burak Şahin (2026-11-02T05:54:00Z): Yes, Pro. I will open a lead.");
    expect(d.activities[0]!.data).toMatchObject({ chatUrl: "https://chat.example.com/chats/12" });
  });

  it("takes a visitor without email, and gives a lead with an unknown agent to leads.owner", async () => {
    const res = await app.admin("/api/v1/leads", {
      method: "POST",
      body: JSON.stringify({ ...lead, external_id: "live-chat-anon", name: null, email: null, owner: { name: "Agent", email: null } }),
    });
    expect(res.status).toBe(201);
    const b = (await res.json()) as { lead: { id: string; contact: string | null } };
    expect(b.lead.contact).toBeNull();
    expect(app.crm.getDeal(EMILY, b.lead.id).owner?.id).toBe(EMILY.id);
  });

  it("refuses what it cannot read", async () => {
    expect((await app.admin("/api/v1/leads", { method: "POST", body: JSON.stringify({ title: "x" }) })).status).toBe(422);
    expect((await app.admin("/api/v1/leads", { method: "POST", body: "{" })).status).toBe(400);
    expect((await fetch(`${app.base}/api/v1/leads`, { method: "POST", body: JSON.stringify(lead) })).status).toBe(401);
  });
});

describe("Audience: POST /api/v1/erasures", () => {
  it("answers done with how many were deleted", async () => {
    app.crm.createContact(EMILY, { name: "To go", email: "togo@example.com" });
    const body = { reference: "KVKK-2026-099", product: "audience", people: { emails: ["togo@example.com"], phones: [], userIds: ["u-1"] } };
    const res = await app.admin("/api/v1/erasures", { method: "POST", body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "done", deleted: 1 });
    expect((await app.admin("/api/v1/lookup?email=togo@example.com")).status).toBe(404);
  });
});
