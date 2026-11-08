import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configWarnings, parseConfig, watchConfig } from "./config.ts";
import { parseAmount, parseCsv, parseDay } from "./csv.ts";
import { phoneKey } from "./store.ts";

describe("crm.yaml", () => {
  it("reads the example file", () => {
    const c = parseConfig(readFileSync(new URL("../config/crm.yaml", import.meta.url), "utf8"));
    expect(c.currency).toBe("TRY");
    expect(c.pipelines[0]!.stages.map((s) => [s.id, s.probability, s.staleDays])).toEqual([
      ["lead", 10, 14],
      ["demo", 25, 10],
      ["proposal", 50, 10],
      ["negotiation", 75, 7],
    ]);
    expect(c.plans.map((p) => p.id)).toEqual(["free", "pro", "business"]);
    expect(c.quotes).toMatchObject({ vat: 20, validDays: 30, language: "tr", seller: { name: "Acme Yazılım A.Ş.", taxNumber: "1234567890" } });
    expect(c.leads).toEqual({ pipeline: "sales", stage: "lead", owner: null });
  });

  it("has defaults for an empty file", () => {
    const c = parseConfig("");
    expect(c.pipelines[0]!.stages).toHaveLength(4);
    expect(c.timeZone).toBe("Europe/Istanbul");
    expect(c.meetingLinks).toEqual([]);
  });

  it("reads meeting links, calendars and the links to Audience and Messages", () => {
    const c = parseConfig(`
pipelines: { sales: { stages: [{ id: lead, probability: 10% }, { id: demo, probability: 0.25 }] } }
calendars: { google: {}, microsoft: { tenant: contoso.onmicrosoft.com } }
meeting_links:
  demo: { owner: Emily@Example.com, length: 45m, hours: "mon-fri 09:00-12:00, mon-fri 13:00-17:00", buffer: 10m, notice: 1d, creates_deal_in: sales/demo }
audience: { url: http://audience:8080, profile: false }
messages: { url: https://messages.example.com, sequences: { follow-up: { name: Follow-up, event: crm_follow_up } } }
`);
    expect(c.meetingLinks[0]).toMatchObject({
      id: "demo",
      owner: "emily@example.com",
      minutes: 45,
      bufferMinutes: 10,
      noticeMinutes: 1440,
      pipeline: "sales",
      stage: "demo",
      online: true,
    });
    expect(c.calendars.google).toEqual({ clientId: "CRM_GOOGLE_CLIENT_ID", clientSecret: "CRM_GOOGLE_CLIENT_SECRET" });
    expect(c.calendars.microsoft?.tenant).toBe("contoso.onmicrosoft.com");
    expect(c.audience).toEqual({ url: "http://audience:8080", token: "CRM_AUDIENCE_TOKEN", events: true, profile: false });
    expect(c.messages?.sequences).toEqual([{ id: "follow-up", name: "Follow-up", event: "crm_follow_up" }]);
    expect(c.pipelines[0]!.stages[1]!.probability).toBe(0.25);
  });

  it("names the field to fix", () => {
    const bad = (yaml: string) => {
      try {
        parseConfig(yaml);
      } catch (err) {
        return (err as Error).message;
      }
      return "accepted";
    };
    expect(bad("currency: lira")).toContain("currency is a three-letter");
    expect(bad("pipelines: { sales: { stages: [{ id: lead, probability: 120% }] } }")).toContain("pipelines.sales.stages[0].probability");
    expect(bad("pipelines: { sales: { stages: [{ id: won, probability: 1% }] } }")).toContain("other than won and lost");
    expect(bad("pipelines: { sales: { stages: [{ id: a, probability: 1%, stale_after: 2h }] } }")).toContain("stale_after is a duration such as 14d");
    expect(bad("leads: { stage: nope }")).toContain("leads.stage: nope is not a stage of sales");
    expect(bad("quotes: { vat: twenty }")).toContain("quotes.vat");
    expect(bad("audience: { url: http://audience.example.com }")).toContain("audience.url");
    expect(bad("audience: { url: https://a.example.com, token: secret-value }")).toContain("never the secret itself");
    expect(bad("meeting_links: { demo: { owner: x@example.com, hours: always } }")).toContain("never always open");
    expect(bad("mail: { host: smtp.example.com, security: none, from: a@b.example }")).toContain("mail.security none");
    expect(bad("sites: []")).toContain("unknown sites");
    expect(bad("plans: { Gold: x }")).toContain("plans.Gold");
  });

  it("warns about secrets that are not set and owners who are not members", () => {
    const c = parseConfig("calendars: { google: {} }\nmeeting_links: { demo: { owner: ghost@example.com } }\naudience: { url: https://a.example.com }");
    expect(configWarnings(c, {}, ["emily@example.com"])).toEqual([
      "calendars.google: CRM_GOOGLE_CLIENT_ID or CRM_GOOGLE_CLIENT_SECRET is not set, so Google Calendar cannot be connected.",
      "meeting_links.demo.owner: ghost@example.com is not a member of CRM.",
      "audience: CRM_AUDIENCE_TOKEN is not set, so nothing is sent to Audience.",
    ]);
  });

  it("keeps the last good file when a new one has a mistake", () => {
    const dir = mkdtempSync(join(tmpdir(), "crm-config-"));
    const path = join(dir, "crm.yaml");
    writeFileSync(path, "currency: EUR");
    const applied: string[] = [];
    const w = watchConfig(path, (c) => (applied.push(c.currency), []), { everyMs: 60_000 });
    writeFileSync(path, "currency: 12");
    w.read();
    expect(applied).toEqual(["EUR"]);
    expect(w.state.error).toContain("currency");
    writeFileSync(path, "currency: usd");
    w.read();
    expect(applied).toEqual(["EUR", "USD"]);
    expect(w.state.error).toBeNull();
    w.stop();
  });
});

describe("CSV and the values in it", () => {
  it("reads quoted fields, semicolons and line breaks in quotes", () => {
    expect(parseCsv('a;b;c\r\n"x;1";"he said ""hi""";"two\nlines"\n\n')).toEqual([
      ["a", "b", "c"],
      ["x;1", 'he said "hi"', "two\nlines"],
    ]);
    expect(parseCsv("﻿name,email\nA,a@x.example")).toEqual([
      ["name", "email"],
      ["A", "a@x.example"],
    ]);
  });

  it("reads amounts written in Turkish, English and plain", () => {
    expect(parseAmount("108.000,00")).toBe(10800000);
    expect(parseAmount("108,000.50")).toBe(10800050);
    expect(parseAmount("45.000")).toBe(4500000);
    expect(parseAmount("45,5")).toBe(4550);
    expect(parseAmount("1.234.567")).toBe(123456700);
    expect(parseAmount("45 000 TL")).toBe(4500000);
    expect(parseAmount("abc")).toBeNull();
  });

  it("reads days as YYYY-MM-DD or DD.MM.YYYY", () => {
    expect(parseDay("28.11.2026")).toBe("2026-11-28");
    expect(parseDay("2026-02-30")).toBeNull();
  });

  it("compares phone numbers by their digits", () => {
    expect(phoneKey("0532 000 00 12")).toBe("905320000012");
    expect(phoneKey("+90 (532) 000-00-12")).toBe("905320000012");
    expect(phoneKey("532 000 00 12")).toBe("905320000012");
  });
});
