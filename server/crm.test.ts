import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrmError } from "./crm.ts";
import { EMILY, HAKAN, SELIN, startApp, VELI, type TestApp } from "./test-app.ts";

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

const DAY = 86_400_000;
const refused = (fn: () => unknown, status: number) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CrmError);
    expect((err as CrmError).status).toBe(status);
    return (err as CrmError).message;
  }
  throw new Error("not refused");
};

describe("the forecast", () => {
  it("counts open deals at value times probability in their expected month, won deals in full", async () => {
    const solo = await startApp();
    const c = solo.crm;
    const proposal = c.createDeal(EMILY, { name: "Renewal", value: 100000, stage: "proposal", expectedClose: "2026-11-20" });
    c.createDeal(EMILY, { name: "Overdue", value: 40000, stage: "negotiation", expectedClose: "2026-10-15" });
    c.createDeal(EMILY, { name: "December", value: 80000, stage: "demo", expectedClose: "2026-12-05" });
    c.createDeal(EMILY, { name: "No date", value: 999999, stage: "lead" });
    const won = c.createDeal(EMILY, { name: "Won one", value: 54000, stage: "negotiation", expectedClose: "2027-02-01" });
    c.closeDeal(EMILY, won.id, {}, "won");
    const lost = c.createDeal(EMILY, { name: "Lost one", value: 120000, stage: "proposal", expectedClose: "2026-11-10" });
    c.closeDeal(EMILY, lost.id, { reason: "chose a cheaper tool" }, "lost");

    expect(proposal.weighted).toBe(50000);
    const r = c.report(EMILY, new URLSearchParams());
    expect(r.month).toBe("2026-11");
    // November: 54,000 won, 50,000 from the proposal, 30,000 from the overdue deal (75% of 40,000), which counts now.
    expect(r.forecast[0]).toMatchObject({ month: "2026-11", won: 54000, weighted: 80000, total: 134000, deals: 2, overdue: 1 });
    expect(r.forecast[1]).toMatchObject({ month: "2026-12", weighted: 20000, deals: 1 });
    expect(r.open).toMatchObject({ count: 4, noCloseDate: 1 });
    expect(r.won).toMatchObject({ count: 1, value: 54000 });
    expect(r.lostReasons).toEqual([{ reason: "Chose a cheaper tool", count: 1, value: 120000 }]);
    expect(r.winRate).toMatchObject({ won: 1, lost: 1, rate: 50 });
    const emily = r.owners.find((o) => o.owner?.id === EMILY.id)!;
    expect(emily).toMatchObject({ deals: 4, forecast: 134000 });
    await solo.close();
  });

  it("measures time in each stage from the history", async () => {
    const d = app.crm.createDeal(EMILY, { name: "Timed", stage: "lead" });
    app.clock.advance(3 * DAY);
    app.crm.moveDeal(EMILY, d.id, { stage: "demo" });
    app.clock.advance(2 * DAY);
    const got = app.crm.getDeal(EMILY, d.id);
    expect(got.timeInStage).toEqual([
      { stage: "lead", days: 3 },
      { stage: "demo", days: 2 },
    ]);
    const lead = app.crm.report(EMILY, new URLSearchParams()).stages.find((s) => s.id === "lead")!;
    expect(lead.avgDays).toBe(3);
    expect(got.activities[0]).toMatchObject({ kind: "system", event: "stage", text: "Moved from Lead to Demo" });
  });
});

describe("stale deals", () => {
  it("are open deals with no activity for longer than their stage allows", () => {
    const d = app.crm.createDeal(EMILY, { name: "Quiet", stage: "demo" });
    app.clock.advance(10 * DAY);
    expect(app.crm.getDeal(EMILY, d.id).stale).toBe(false);
    app.clock.advance(DAY);
    expect(app.crm.getDeal(EMILY, d.id)).toMatchObject({ stale: true, quietDays: 11, staleAfter: 10 });
    expect(app.crm.summary(EMILY).stale).toBeGreaterThan(0);
    app.crm.logActivity(EMILY, { kind: "call", text: "Called, no answer", deal: d.id });
    expect(app.crm.getDeal(EMILY, d.id).stale).toBe(false);
    // Won and lost deals are never stale.
    app.clock.advance(30 * DAY);
    app.crm.closeDeal(EMILY, d.id, { reason: "Not this year" }, "lost");
    expect(app.crm.getDeal(EMILY, d.id).stale).toBe(false);
  });
});

describe("ownership", () => {
  it("lets viewers see, editors change what they own, admins everything", () => {
    const d = app.crm.createDeal(EMILY, { name: "Emily's", value: 1000 });
    expect(d.owner).toEqual({ id: EMILY.id, name: EMILY.name });
    expect(app.crm.getDeal(HAKAN, d.id).canEdit).toBe(false);
    expect(refused(() => app.crm.updateDeal(HAKAN, d.id, { value: 5 }), 403)).toContain("Emily Clark's");
    refused(() => app.crm.moveDeal(HAKAN, d.id, { stage: "demo" }), 403);
    refused(() => app.crm.logActivity(HAKAN, { kind: "note", text: "x", deal: d.id }), 403);
    expect(app.crm.updateDeal(SELIN, d.id, { value: 2000 }).value).toBe(2000);
    expect(app.crm.canChange(VELI, null)).toBe(false);
    expect(app.crm.getDeal(VELI, d.id).canEdit).toBe(false);
    // Giving it away: then it is Hakan's to change.
    app.crm.updateDeal(EMILY, d.id, { owner: HAKAN.id });
    refused(() => app.crm.updateDeal(EMILY, d.id, { value: 1 }), 403);
    expect(app.crm.updateDeal(HAKAN, d.id, { value: 3000 }).value).toBe(3000);
  });

  it("lets any editor take what nobody owns", () => {
    const d = app.crm.createDeal(SELIN, { name: "Unowned", owner: null });
    expect(d.owner).toBeNull();
    expect(app.crm.updateDeal(HAKAN, d.id, { owner: HAKAN.id }).owner?.id).toBe(HAKAN.id);
  });

  it("applies to contacts and companies too", () => {
    const co = app.crm.createCompany(EMILY, { name: "Avcı Lojistik", plan: "business", users: 48, city: "İstanbul" });
    refused(() => app.crm.updateCompany(HAKAN, co.id, { city: "İzmir" }), 403);
    const ct = app.crm.createContact(EMILY, { name: "Gizem Avcı", email: "Gizem@Avci.example", company: co.id });
    expect(ct.email).toBe("gizem@avci.example");
    refused(() => app.crm.removeContact(HAKAN, ct.id), 403);
    expect(refused(() => app.crm.createContact(HAKAN, { name: "Other", email: "gizem@avci.example" }), 409)).toContain("Gizem Avcı");
  });
});

describe("won and lost", () => {
  it("needs a reason from the file to lose a deal, and keeps it", () => {
    const d = app.crm.createDeal(EMILY, { name: "To lose", value: 5000 });
    expect(refused(() => app.crm.closeDeal(EMILY, d.id, {}, "lost"), 422)).toContain("Chose a cheaper tool");
    refused(() => app.crm.closeDeal(EMILY, d.id, { reason: "Weather" }, "lost"), 422);
    const lost = app.crm.closeDeal(EMILY, d.id, { reason: "stopped answering", note: "Three calls." }, "lost");
    expect(lost).toMatchObject({ status: "lost", reason: "Stopped answering", reasonNote: "Three calls.", weighted: 0 });
    refused(() => app.crm.moveDeal(EMILY, d.id, { stage: "demo" }), 409);
    const back = app.crm.reopenDeal(EMILY, d.id, {});
    expect(back).toMatchObject({ status: "open", stage: { id: "lead" }, reason: null });
  });
});

describe("tasks and reminders", () => {
  it("reminds the owner by email the morning a task is due, with their stale deals", async () => {
    const deal = app.crm.createDeal(EMILY, { name: "Reminded" });
    const now = app.clock();
    const tomorrow = new Date(now + DAY).toISOString().slice(0, 10);
    const task = app.crm.createTask(EMILY, { text: "Call Gizem about the 3-year price", due: tomorrow, deal: deal.id });
    expect(task.owner?.id).toBe(EMILY.id);
    expect(task.remindAt).not.toBeNull();
    app.mails.length = 0;
    await app.crm.remind();
    expect(app.mails).toHaveLength(0);
    app.clock.set(Date.parse(task.remindAt!) + 60_000);
    await app.crm.remind();
    expect(app.mails).toHaveLength(1);
    expect(app.mails[0]).toMatchObject({ to: "emily@example.com", subject: "Due today: Call Gizem about the 3-year price" });
    await app.crm.remind();
    expect(app.mails).toHaveLength(1);
    const done = app.crm.updateTask(EMILY, task.id, { done: true });
    expect(done.doneAt).not.toBeNull();
    expect(app.crm.getDeal(EMILY, deal.id).activities[0]).toMatchObject({ event: "task-done" });
  });

  it("tries a failed reminder again", async () => {
    const t = app.crm.createTask(EMILY, { text: "Retry me", due: new Date(app.clock() + DAY).toISOString().slice(0, 10) });
    app.clock.set(Date.parse(t.remindAt!) + 1000);
    app.mails.length = 0;
    app.mailer.fail = true;
    await app.crm.remind();
    app.mailer.fail = false;
    await app.crm.remind();
    expect(app.mails.map((m) => m.subject)).toEqual(["Due today: Retry me"]);
  });

  it("lets editors give tasks to others only on their own deals", () => {
    const mine = app.crm.createDeal(EMILY, { name: "Mine" });
    expect(app.crm.createTask(EMILY, { text: "For Hakan", due: "2026-12-01", deal: mine.id, owner: HAKAN.id }).owner?.id).toBe(HAKAN.id);
    refused(() => app.crm.createTask(EMILY, { text: "No", due: "2026-12-01", owner: HAKAN.id }), 403);
  });
});

describe("quotes", () => {
  it("adds KDV on its own line, fixes a sent quote, and wins the deal when accepted", async () => {
    const d = app.crm.createDeal(EMILY, { name: "Renewal and 20 more users", value: 100 });
    const q = app.crm.createQuote(EMILY, d.id, {
      lines: [
        { item: "Business, 48 users, 12 months", quantity: 48, unitPrice: 3750 },
        { item: "Business, 20 more users", quantity: 20, unitPrice: 3750 },
        { item: "Onboarding for the Mersin depot", quantity: 1, unitPrice: 50000, discount: 10 },
      ],
    });
    expect(q.number).toMatch(/^Q-2026-\d{3}$/);
    expect(q).toMatchObject({ state: "draft", vat: 20, subtotal: 300000, vatAmount: 60000, total: 360000 });
    const sent = await app.crm.sendQuote(EMILY, q.id, { email: false });
    expect(sent.state).toBe("sent");
    // The deal is worth what was quoted, without KDV.
    expect(app.crm.getDeal(EMILY, d.id).value).toBe(300000);
    refused(() => app.crm.updateQuote(EMILY, q.id, { notes: "x" }), 409);
    app.crm.decideQuote(EMILY, q.id, "accepted");
    expect(app.crm.getDeal(EMILY, d.id)).toMatchObject({ status: "won", value: 300000 });
    // The next quote starts from the last one's lines.
    const d2 = app.crm.createDeal(EMILY, { name: "Copy" });
    expect(app.crm.createQuote(EMILY, d2.id, {}).lines).toEqual([{ item: "Copy", quantity: 1, unitPrice: 0, discount: 0, total: 0 }]);
  });

  it("sends the PDF by email", async () => {
    const ct = app.crm.createContact(EMILY, { name: "Okan Tekin", email: "okan@tekin.example" });
    const d = app.crm.createDeal(EMILY, { name: "12 users", value: 108000, contact: ct.id });
    const q = app.crm.createQuote(EMILY, d.id, {});
    app.mails.length = 0;
    await app.crm.sendQuote(EMILY, q.id, { email: true });
    expect(app.mails[0]!.to).toBe("okan@tekin.example");
    expect(app.mails[0]!.attachments![0]).toMatchObject({ filename: `${q.number}.pdf`, contentType: "application/pdf" });
    expect(app.mails[0]!.attachments![0]!.content.subarray(0, 5).toString()).toBe("%PDF-");
    expect(app.crm.getDeal(EMILY, d.id).activities[0]).toMatchObject({ kind: "email", text: `Sent quote ${q.number} as PDF to okan@tekin.example` });
  });
});

describe("Audience", () => {
  it("receives contact and deal events with source crm", async () => {
    await app.crm.flush();
    app.fakes.state.audience.events.length = 0;
    const ct = app.crm.createContact(EMILY, { name: "Seda Polat", email: "seda@polat.example", phone: "0532 000 00 12" });
    const d = app.crm.createDeal(EMILY, { name: "Business upgrade", contact: ct.id, value: 84000 });
    app.crm.updateContact(EMILY, ct.id, { title: "Finance lead" });
    app.crm.moveDeal(EMILY, d.id, { stage: "demo" });
    app.crm.closeDeal(EMILY, d.id, {}, "won");
    await app.crm.flush();
    const events = app.fakes.state.audience.events;
    expect(events.map((e) => e.type)).toEqual(["contact_created", "deal_opened", "contact_changed", "deal_stage_changed", "deal_won"]);
    expect(events.every((e) => e.source === "crm")).toBe(true);
    expect(events[3]).toMatchObject({
      person: { email: "seda@polat.example", phone: "0532 000 00 12", name: "Seda Polat" },
      properties: { stage: "Demo", status: "open", value: 84000, from: "Lead" },
    });
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    expect(app.crm.integrations().audience).toMatchObject({ queued: 0, error: null });
  });

  it("keeps events while Audience is down and sends them later", async () => {
    app.fakes.state.audience.events.length = 0;
    app.fakes.state.audience.status = 503;
    app.crm.createContact(EMILY, { name: "Later", email: "later@example.com" });
    await app.crm.flush();
    expect(app.crm.integrations().audience.queued).toBe(1);
    app.fakes.state.audience.status = 200;
    app.clock.advance(2 * 60_000);
    await app.crm.flush();
    expect(app.fakes.state.audience.events.map((e) => e.type)).toEqual(["contact_created"]);
  });

  it("shows the lead's profile on the deal", async () => {
    app.fakes.state.audience.people.set("gizem@profile.example", {
      id: "p-77",
      events: [
        {
          id: 1,
          source: "analytics",
          type: "page_viewed",
          at: new Date(app.clock() - DAY).toISOString(),
          text: "Viewed /pricing",
          properties: { path: "/pricing" },
        },
        {
          id: 2,
          source: "analytics",
          type: "page_viewed",
          at: new Date(app.clock() - 2 * DAY).toISOString(),
          text: "Viewed /pricing",
          properties: { path: "/pricing" },
        },
        {
          id: 3,
          source: "analytics",
          type: "page_viewed",
          at: new Date(app.clock() - 3 * DAY).toISOString(),
          text: "Viewed /features",
          properties: { path: "/features" },
        },
        { id: 4, source: "forms", type: "form_submitted", at: new Date(app.clock() - DAY).toISOString(), text: "Sent the form demo", properties: {} },
        { id: 5, source: "crm", type: "deal_opened", at: new Date(app.clock()).toISOString(), text: "ours", properties: {} },
      ],
    });
    const ct = app.crm.createContact(EMILY, { name: "Gizem P", email: "gizem@profile.example" });
    const d = app.crm.createDeal(EMILY, { name: "Profiled", contact: ct.id });
    const a = await app.crm.audienceProfile(d.id);
    expect(a).toMatchObject({
      linked: true,
      found: true,
      profile: {
        pages: [
          { path: "/pricing", views: 2 },
          { path: "/features", views: 1 },
        ],
      },
    });
    expect(a.profile!.recent.map((e) => e.text)).toEqual(["Sent the form demo"]);
    const nobody = app.crm.createDeal(EMILY, { name: "No contact" });
    expect(await app.crm.audienceProfile(nobody.id)).toMatchObject({ linked: true, found: false });
  });

  it("erases a person on request, once per reference", () => {
    const co = app.crm.createCompany(EMILY, { name: "Erase Co" });
    const ct = app.crm.createContact(EMILY, { name: "Mehmet Demir", email: "mehmet@demir.example", phone: "+90 532 111 22 33" });
    const own = app.crm.createDeal(EMILY, { name: "His alone", contact: ct.id });
    const shared = app.crm.createDeal(EMILY, { name: "The company's", contact: ct.id, company: co.id });
    app.crm.logActivity(EMILY, { kind: "note", text: "Talked to Mehmet", contact: ct.id });
    const r = app.crm.erase({ reference: "KVKK-2026-031", product: "audience", people: { emails: [], phones: ["05321112233"], userIds: [] } });
    expect(r).toEqual({ status: "done", deleted: 1 });
    expect(() => app.crm.getContact(EMILY, ct.id)).toThrow(CrmError);
    expect(() => app.crm.getDeal(EMILY, own.id)).toThrow(CrmError);
    expect(app.crm.getDeal(EMILY, shared.id).contact).toBeNull();
    expect(app.crm.erase({ reference: "KVKK-2026-031", product: "audience", people: { emails: [], phones: [], userIds: [] } })).toEqual({
      status: "done",
      deleted: 1,
    });
  });
});

describe("Messages", () => {
  it("starts a sales sequence with the sequence's event, and posts won deals", async () => {
    app.fakes.state.messages.events.length = 0;
    const ct = app.crm.createContact(EMILY, { name: "Nihan Er", email: "nihan@er.example" });
    const d = app.crm.createDeal(EMILY, { name: "5 users", contact: ct.id });
    expect(app.crm.startSequence(EMILY, d.id, { sequence: "follow-up" })).toEqual({ sequence: "follow-up", event: "crm_demo_follow_up", queued: true });
    app.crm.closeDeal(EMILY, d.id, {}, "won");
    await app.crm.flush();
    expect(app.fakes.state.messages.events).toEqual([
      {
        type: "crm_demo_follow_up",
        person: {
          email: "nihan@er.example",
          name: "Nihan Er",
          fields: { deal: "5 users", company: "", owner: "Emily Clark", stage: "Lead", first_name: "Nihan" },
        },
      },
      { type: "deal_won", person: { email: "nihan@er.example", name: "Nihan Er", fields: { deal: "5 users", company: "" } } },
    ]);
    const none = app.crm.createDeal(EMILY, { name: "No email" });
    refused(() => app.crm.startSequence(EMILY, none.id, { sequence: "follow-up" }), 409);
  });
});

describe("CSV import", () => {
  it("imports semicolon CSV with Turkish amounts and dates, and a dry run changes nothing", () => {
    const csv =
      "Name;Company;Email;Value;Stage;Expected close;Owner\n12 users;Tekin Yapı;okan@tekin-import.example;108.000,00;Demo;28.11.2026;hakan@example.com\nBad;X;;abc;Lead;;\n";
    const dry = app.crm.importCsv(SELIN, { kind: "deals", csv, dryRun: true });
    expect(dry).toMatchObject({ rows: 2, created: 1, skipped: 1, dryRun: true });
    expect(dry.errors[0]).toMatchObject({ row: 3 });
    expect(app.crm.listDeals(SELIN, new URLSearchParams({ q: "12 users" })).filter((d) => d.company?.name === "Tekin Yapı")).toHaveLength(0);
    const done = app.crm.importCsv(SELIN, { kind: "deals", csv });
    expect(done.created).toBe(1);
    const d = app.crm.listDeals(SELIN, new URLSearchParams({ q: "tekin yapı" }))[0]!;
    expect(d).toMatchObject({
      value: 108000,
      stage: { id: "demo" },
      expectedClose: "2026-11-28",
      owner: { id: HAKAN.id },
      source: "import",
      contact: { email: "okan@tekin-import.example" },
    });
  });

  it("updates companies by name and contacts by email", () => {
    app.crm.importCsv(EMILY, { kind: "companies", csv: "name,city,plan,users\nKaya Eczane,Ankara,Business,8\n" });
    const r = app.crm.importCsv(EMILY, { kind: "companies", csv: "name,city\nkaya eczane,İzmir\n" });
    expect(r).toMatchObject({ created: 0, updated: 1 });
    const co = app.crm.listCompanies(EMILY, new URLSearchParams({ q: "Kaya Eczane" }))[0]!;
    expect(co).toMatchObject({ city: "İzmir", plan: { id: "business" }, users: 8 });
    const c = app.crm.importCsv(EMILY, {
      kind: "contacts",
      csv: 'name,email,company,title\n"Elif Kaya","elif@kaya.example",Kaya Eczane,"Owner, pharmacist"\n',
    });
    expect(c.created).toBe(1);
    expect(app.crm.lookup("elif@kaya.example").contact).toMatchObject({ title: "Owner, pharmacist", plan: { id: "business", name: "Business" } });
  });
});
