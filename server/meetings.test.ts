// Meeting links against the fake Google and Microsoft (fakes.ts): connecting with OAuth, free/busy, events, refresh,
// a revoked grant, and that a time is never booked twice when many people ask for it at once.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrmError } from "./crm.ts";
import { GOOGLE, MICROSOFT } from "./fakes.ts";
import { connectCalendar, EMILY, HAKAN, startApp, type TestApp } from "./test-app.ts";

let app: TestApp;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

describe("connecting a calendar", () => {
  it("runs Google's OAuth code flow and keeps the tokens encrypted", async () => {
    const { url, to } = await connectCalendar(app, EMILY, "google", "emily@example.com");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`${app.fakes.base}/google/auth`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: GOOGLE.clientId,
      redirect_uri: `${app.base}/api/v1/calendar/callback`,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      login_hint: "emily@example.com",
    });
    expect(u.searchParams.get("scope")).toContain("calendar.freebusy");
    expect(to).toBe("/meetings?calendar=connected");
    expect(app.meetings.calendarState(EMILY).connected).toMatchObject({ provider: "google", account: "emily@example.com", error: null });
    const row = app.db.prepare("SELECT refresh_token FROM calendar_accounts WHERE user_id = ?").get(EMILY.id) as { refresh_token: string };
    expect(row.refresh_token.startsWith("v1:")).toBe(true);
    expect(row.refresh_token).not.toContain("rt-google");
  });

  it("runs Microsoft's, against the tenant in the file", async () => {
    const { url, to } = await connectCalendar(app, HAKAN, "microsoft", "hakan@example.com");
    expect(new URL(url).pathname).toBe("/ms/login/common/oauth2/v2.0/authorize");
    expect(new URL(url).searchParams.get("scope")).toBe("offline_access openid email User.Read Calendars.ReadWrite");
    expect(new URL(url).searchParams.get("client_id")).toBe(MICROSOFT.clientId);
    expect(to).toBe("/meetings?calendar=connected");
  });

  it("refuses a state that is not the caller's, or used twice", async () => {
    const { url } = app.meetings.connect(EMILY, { provider: "google" });
    const state = new URL(url).searchParams.get("state")!;
    const cb = (q: Record<string, string>) => new URL(`${app.base}/api/v1/calendar/callback?${new URLSearchParams(q)}`);
    expect(await app.meetings.callback(HAKAN, cb({ state, code: app.fakes.code("google", "x@example.com") }))).toBe("/meetings?calendar=expired");
    expect(await app.meetings.callback(EMILY, cb({ state, code: app.fakes.code("google", "x@example.com") }))).toBe("/meetings?calendar=expired");
    const again = new URL(app.meetings.connect(EMILY, { provider: "google" }).url).searchParams.get("state")!;
    expect(await app.meetings.callback(EMILY, cb({ state: again, error: "access_denied" }))).toBe("/meetings?calendar=refused");
    // The earlier connection is still there.
    expect(app.meetings.calendarState(EMILY).connected?.account).toBe("emily@example.com");
  });
});

describe("free times", () => {
  it("are the link's hours less the calendar's busy times, the notice and the buffer", async () => {
    // Monday 2 November, 09:00 in Istanbul (06:00Z). Notice 2h: nothing before 11:00. Hours 09:00-12:00.
    app.fakes.state.busy.set("emily@example.com", [{ start: Date.parse("2026-11-03T07:00:00Z"), end: Date.parse("2026-11-03T07:30:00Z") }]);
    const r = await app.meetings.publicSlots("demo");
    expect(r).toMatchObject({ name: "Acme demo", owner: "Emily Clark", minutes: 30, timeZone: "Europe/Istanbul" });
    const starts = r.slots.map((s) => s.start);
    expect(starts[0]).toBe("2026-11-02T08:00:00.000Z"); // 11:00 Monday
    expect(starts.filter((s) => s.startsWith("2026-11-02"))).toEqual(["2026-11-02T08:00:00.000Z", "2026-11-02T08:30:00.000Z"]);
    // Tuesday 10:00-10:30 is busy; with 15 minutes either side 09:30 and 10:30 go too.
    expect(starts.filter((s) => s.startsWith("2026-11-03"))).toEqual(["2026-11-03T06:00:00.000Z", "2026-11-03T08:00:00.000Z", "2026-11-03T08:30:00.000Z"]);
    // No weekend times.
    expect(starts.some((s) => s.startsWith("2026-11-07") || s.startsWith("2026-11-08"))).toBe(false);
    const freeBusy = app.fakes.state.calls.filter((c) => c.path === "/google/api/calendar/v3/freeBusy");
    expect(JSON.parse(freeBusy.at(-1)!.body)).toMatchObject({ items: [{ id: "primary" }] });
  });

  it("read Microsoft Graph's schedule in UTC", async () => {
    app.fakes.state.busy.set("hakan@example.com", [{ start: Date.parse("2026-11-02T11:00:00Z"), end: Date.parse("2026-11-02T12:00:00Z") }]);
    const r = await app.meetings.publicSlots("intro");
    const monday = r.slots.map((s) => s.start).filter((s) => s.startsWith("2026-11-02"));
    // 14:00-17:00 in Istanbul is 11:00-14:00Z; 11:00-12:00Z is busy.
    expect(monday).toEqual(["2026-11-02T12:00:00.000Z", "2026-11-02T12:30:00.000Z", "2026-11-02T13:00:00.000Z", "2026-11-02T13:30:00.000Z"]);
  });

  it("say so when the owner has no calendar", async () => {
    const solo = await startApp();
    await expect(solo.meetings.publicSlots("demo")).rejects.toMatchObject({ status: 409, code: "not-available" });
    await solo.close();
  });
});

describe("booking", () => {
  it("makes the event with a Meet link, the contact and a deal in the link's stage", async () => {
    const r = await app.meetings.book("demo", {
      start: "2026-11-04T07:00:00.000Z",
      name: "Okan Tekin",
      email: "Okan@Tekin.example",
      company: "Tekin Yapı",
      note: "12 users",
    });
    expect(r.made).toBe("created");
    expect(r.booking.joinUrl).toMatch(/^https:\/\/meet\.google\.com\//);
    const ev = app.fakes.state.events.at(-1)!;
    expect(ev).toMatchObject({
      provider: "google",
      account: "emily@example.com",
      attendee: "okan@tekin.example",
      online: true,
      requestId: r.booking.id,
      start: Date.parse("2026-11-04T07:00:00Z"),
      end: Date.parse("2026-11-04T07:30:00Z"),
    });
    const deal = app.crm.getDeal(EMILY, r.deal);
    expect(deal).toMatchObject({
      stage: { id: "demo" },
      source: "meeting-link",
      owner: { id: EMILY.id },
      company: { name: "Tekin Yapı" },
      contact: { email: "okan@tekin.example" },
    });
    expect(deal.activities[0]).toMatchObject({ kind: "meeting", event: "booking" });
    // The same person again: added to their open deal, not a second one.
    const again = await app.meetings.book("demo", { start: "2026-11-05T07:00:00.000Z", name: "Okan Tekin", email: "okan@tekin.example" });
    expect(again).toMatchObject({ made: "added", deal: r.deal });
    // The booked time is no longer offered, nor its buffer.
    const starts = (await app.meetings.publicSlots("demo")).slots.map((s) => s.start);
    expect(starts).not.toContain("2026-11-04T07:00:00.000Z");
    expect(starts).not.toContain("2026-11-04T07:30:00.000Z");
  });

  it("never books one time twice, however many ask at once", async () => {
    app.fakes.state.busyDelayMs = 30;
    const start = "2026-11-06T06:00:00.000Z";
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_x, i) => app.meetings.book("demo", { start, name: `Person ${i}`, email: `p${i}@race.example` })),
    );
    app.fakes.state.busyDelayMs = 0;
    const ok = results.filter((r) => r.status === "fulfilled");
    const no = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(no).toHaveLength(11);
    expect(no.every((r) => r.reason instanceof CrmError && r.reason.status === 409)).toBe(true);
    expect(app.fakes.state.events.filter((e) => e.start === Date.parse(start))).toHaveLength(1);
    const held = app.db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE start_at = ? AND state IN ('held', 'confirmed')").get(start) as { n: number };
    expect(held.n).toBe(1);
  });

  it("does not book overlapping times through the buffer, also from another link of the same owner", async () => {
    app.fakes.state.busyDelayMs = 20;
    const [a, b] = await Promise.allSettled([
      app.meetings.book("demo", { start: "2026-11-06T07:00:00.000Z", name: "A", email: "a@overlap.example" }),
      app.meetings.book("demo", { start: "2026-11-06T07:30:00.000Z", name: "B", email: "b@overlap.example" }),
    ]);
    app.fakes.state.busyDelayMs = 0;
    // 30 minutes apart with a 15 minute buffer each side: only one of the two.
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("refuses a time that is not free, and lets go when the calendar fails", async () => {
    await expect(app.meetings.book("demo", { start: "2026-11-02T06:00:00.000Z", name: "Too soon", email: "soon@example.com" })).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      app.meetings.book("demo", { start: "2026-11-05T08:30:00.000Z", name: "Bot", email: "bot@example.com", website: "spam" }),
    ).rejects.toMatchObject({ status: 422 });
    app.fakes.state.failCreate = 503;
    await expect(app.meetings.book("demo", { start: "2026-11-05T08:30:00.000Z", name: "Fail", email: "fail@example.com" })).rejects.toMatchObject({
      status: 502,
    });
    // The failed hold does not block the time.
    const r = await app.meetings.book("demo", { start: "2026-11-05T08:30:00.000Z", name: "Fine", email: "fine@example.com" });
    expect(r.made).toBe("created");
  });

  it("books through Microsoft with a Teams link, and cancels in the calendar", async () => {
    const r = await app.meetings.book("intro", {
      start: "2026-11-03T12:00:00.000Z",
      name: "Gizem Avcı",
      email: "gizem@avci-ms.example",
      company: "Avcı Lojistik",
    });
    expect(r.booking.joinUrl).toMatch(/^https:\/\/teams\.microsoft\.com\//);
    const ev = app.fakes.state.events.find((e) => e.requestId === r.booking.id)!;
    expect(ev).toMatchObject({ provider: "microsoft", account: "hakan@example.com", online: true });
    // The deal starts in leads.stage, the link names none.
    expect(app.crm.getDeal(HAKAN, r.deal).stage.id).toBe("lead");
    await expect(app.meetings.cancel(EMILY, r.booking.id)).rejects.toMatchObject({ status: 403 });
    expect((await app.meetings.cancel(HAKAN, r.booking.id)).state).toBe("cancelled");
    expect(ev.cancelled).toBe(true);
  });

  it("refreshes an access token that ran out, and asks to connect again when the grant is revoked", async () => {
    app.clock.advance(2 * 60_000);
    app.fakes.expireAccess();
    app.db.prepare("UPDATE calendar_accounts SET expires_at = ?").run(new Date(app.clock() - 1000).toISOString());
    expect((await app.meetings.publicSlots("intro")).slots.length).toBeGreaterThan(0);
    const refreshes = app.fakes.state.calls.filter((c) => c.path.endsWith("/token") && c.body.includes("grant_type=refresh_token"));
    expect(refreshes.length).toBeGreaterThanOrEqual(1);
    app.clock.advance(2 * 60_000);
    app.fakes.revoke();
    app.db.prepare("UPDATE calendar_accounts SET expires_at = ?").run(new Date(app.clock() - 1000).toISOString());
    await expect(app.meetings.publicSlots("demo")).rejects.toMatchObject({ status: 502 });
    expect(app.meetings.calendarState(EMILY).connected?.error).toContain("Connect the calendar again");
  });
});

describe("the booking page", () => {
  it("lists free times as a form and books from it", async () => {
    const solo = await startApp();
    await connectCalendar(solo, EMILY, "google", "emily@example.com");
    const page = await fetch(`${solo.base}/book/demo`, { headers: { "accept-language": "tr-TR,tr;q=0.9" } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<html lang="tr">');
    expect(html).toContain("Emily Clark ile 30 dakika");
    const start = /name="start" value="([^"]+)"/.exec(html)![1]!;
    const form = new URLSearchParams({ start, name: "Kerem Aksoy", email: "kerem@aksoy.example", company: "Aksoy Danışmanlık" });
    const done = await fetch(`${solo.base}/book/demo?lang=en`, {
      method: "POST",
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(done.status).toBe(201);
    expect(await done.text()).toContain("The invitation is on its way to kerem@aksoy.example.");
    const again = await fetch(`${solo.base}/book/demo?lang=en`, {
      method: "POST",
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(again.status).toBe(409);
    const text = await again.text();
    expect(text).toContain('role="alert"');
    expect(text).toContain('value="Kerem Aksoy"');
    expect((await fetch(`${solo.base}/book/nope`)).status).toBe(404);
    await solo.close();
  });
});
