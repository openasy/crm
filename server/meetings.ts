// Meeting links: a page where people book a time in a member's free hours, read from the Google or Microsoft calendar
// that member connected. Each booking makes the event in that calendar (with a Meet or Teams link), and finds or makes
// the contact and the deal (crm.fromBooking).
//
// No time is booked twice. Before the calendar is written, the booking is held in the database: in one write
// transaction (BEGIN IMMEDIATE) CRM checks that no held or confirmed booking of the same member overlaps the time with
// its buffers, and inserts the hold. node:sqlite runs that transaction without yielding, and the immediate lock keeps
// another process on the same file out, so of two requests for the same time only one gets the hold; the other is
// told the time was just taken. The calendar's own free/busy is read again, fresh, for every booking.
import { randomBytes, randomUUID } from "node:crypto";
import { atLeast } from "@openasy/auth";
import { CalendarError, googleCalendar, microsoftCalendar, sealer, type CalendarKind, type CalendarProvider, type Endpoints } from "./calendar.ts";
import { linkHours, type Config, type MeetingLink } from "./config.ts";
import type { Crm, Member } from "./crm.ts";
import { intervals } from "./hours.ts";
import { log } from "./log.ts";
import { bad, body, CrmError, MINUTE, notFound, optEmail, optText, text, type Actor } from "./store.ts";

interface AccountRow {
  user_id: string;
  provider: CalendarKind;
  account: string;
  refresh_token: string;
  access_token: string | null;
  expires_at: string | null;
  connected_at: string;
  ok_at: string | null;
  error: string | null;
}

interface BookingRow {
  id: string;
  link: string;
  owner_email: string;
  start_at: string;
  end_at: string;
  block_from: string;
  block_to: string;
  state: "held" | "confirmed" | "cancelled" | "failed";
  name: string;
  email: string;
  company: string | null;
  note: string | null;
  contact_id: string | null;
  deal_id: string | null;
  made: string | null;
  event_id: string | null;
  join_url: string | null;
  error: string | null;
  created_at: string;
}

export interface MeetingsOptions {
  publicUrl: string;
  env?: Record<string, string | undefined>;
  /** 32 bytes that encrypt calendar tokens at rest (ADR 0021). */
  secretsKey?: Buffer;
  /** For tests: where Google and Microsoft are reached. */
  endpoints?: Endpoints;
  /** For tests: the providers themselves. */
  providers?: (c: Config) => Partial<Record<CalendarKind, CalendarProvider>>;
}

/** How long a slot list's free/busy is kept; a booking always reads it fresh. */
const BUSY_CACHE = MINUTE;
/** A hold whose calendar event was never confirmed, such as after a crash, lets go of its time after this. */
const HOLD = 10 * MINUTE;

export function createMeetings(crm: Crm, opts: MeetingsOptions) {
  const { q, one, run, tx, iso, clock } = crm.store;
  const env = opts.env ?? process.env;
  const seal = sealer(opts.secretsKey);
  const busyCache = new Map<string, { at: number; from: number; to: number; busy: Array<{ start: number; end: number }> }>();
  const redirectUri = `${opts.publicUrl}/api/v1/calendar/callback`;

  function providers(): Partial<Record<CalendarKind, CalendarProvider>> {
    const c = crm.config();
    if (!c) return {};
    if (opts.providers) return opts.providers(c);
    const out: Partial<Record<CalendarKind, CalendarProvider>> = {};
    const g = c.calendars.google;
    if (g && env[g.clientId] && env[g.clientSecret])
      out.google = googleCalendar({ clientId: env[g.clientId]!, clientSecret: env[g.clientSecret]!, endpoints: opts.endpoints?.google, now: clock });
    const m = c.calendars.microsoft;
    if (m && env[m.clientId] && env[m.clientSecret])
      out.microsoft = microsoftCalendar({
        clientId: env[m.clientId]!,
        clientSecret: env[m.clientSecret]!,
        tenant: m.tenant,
        endpoints: opts.endpoints?.microsoft,
        now: clock,
      });
    return out;
  }

  const member = (email: string): Member | undefined => crm.memberByEmail(email);
  const accountOf = (userId: string) => one<AccountRow>("SELECT * FROM calendar_accounts WHERE user_id = ?", userId);

  // ------------------------------------------------------------------ connecting a calendar

  function calendarState(who: Actor) {
    const a = accountOf(who.id);
    const c = crm.config();
    const ready = providers();
    return {
      available: (["google", "microsoft"] as const).filter((k) => !!c?.calendars[k]).map((k) => ({ provider: k, ready: !!ready[k] })),
      connected: a ? { provider: a.provider, account: a.account, connectedAt: a.connected_at, okAt: a.ok_at, error: a.error } : null,
    };
  }

  function connect(who: Actor, raw: unknown) {
    const b = body(raw, ["provider"]);
    const kind = b.provider as CalendarKind;
    if (kind !== "google" && kind !== "microsoft") throw bad("provider is google or microsoft.");
    const p = providers()[kind];
    if (!p)
      throw new CrmError(
        409,
        "not-linked",
        `${kind === "google" ? "Google" : "Microsoft"} is not set up under calendars in the settings file, or its client id and secret are not set.`,
      );
    if (who.id.startsWith("token:") || who.id === "admin-token")
      throw new CrmError(409, "conflict", "A calendar is connected by a signed-in member, not an API token.");
    const state = randomBytes(24).toString("base64url");
    tx(() => {
      run("DELETE FROM oauth_states WHERE created_at < ?", iso(clock() - HOLD));
      run("INSERT INTO oauth_states (state, user_id, provider, created_at) VALUES (?, ?, ?, ?)", state, who.id, kind, iso());
    });
    const email = crm.team().find((m) => m.id === who.id)?.email;
    return { url: p.authUrl({ state, redirectUri, loginHint: email }) };
  }

  /** Where the provider sends the browser back. Answers with the page to show next. */
  async function callback(who: Actor, url: URL): Promise<string> {
    const state = url.searchParams.get("state") ?? "";
    const row = one<{ user_id: string; provider: CalendarKind; created_at: string }>("SELECT * FROM oauth_states WHERE state = ?", state);
    run("DELETE FROM oauth_states WHERE state = ?", state);
    const back = (r: string) => `/meetings?calendar=${encodeURIComponent(r)}`;
    if (!row || row.user_id !== who.id || clock() - Date.parse(row.created_at) > HOLD) return back("expired");
    if (url.searchParams.get("error")) return back("refused");
    const p = providers()[row.provider];
    const code = url.searchParams.get("code");
    if (!p || !code) return back("failed");
    try {
      const t = await p.exchange(code, redirectUri);
      run(
        `INSERT INTO calendar_accounts (user_id, provider, account, refresh_token, access_token, expires_at, connected_at, ok_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (user_id) DO UPDATE SET provider = excluded.provider, account = excluded.account, refresh_token = excluded.refresh_token,
           access_token = excluded.access_token, expires_at = excluded.expires_at, connected_at = excluded.connected_at, ok_at = excluded.ok_at, error = NULL`,
        who.id,
        row.provider,
        t.account,
        seal.seal(t.refreshToken!),
        seal.seal(t.accessToken),
        iso(t.expiresAt),
        iso(),
        iso(),
      );
      busyCache.clear();
      log("info", "calendar connected", { user: who.id, provider: row.provider });
      return back("connected");
    } catch (err) {
      log("warn", "calendar could not be connected", { user: who.id, provider: row.provider, error: String(err) });
      return back("failed");
    }
  }

  function disconnect(who: Actor) {
    run("DELETE FROM calendar_accounts WHERE user_id = ?", who.id);
    busyCache.clear();
  }

  /** A working access token for the member's calendar, refreshed when it is about to end. */
  async function access(userId: string): Promise<{ provider: CalendarProvider; token: string; account: string }> {
    const a = accountOf(userId);
    if (!a) throw new CrmError(409, "not-available", "The meeting link's owner has not connected a calendar.");
    const provider = providers()[a.provider];
    if (!provider) throw new CrmError(409, "not-available", `${a.provider} is no longer set up in the settings file.`);
    if (a.access_token && a.expires_at && Date.parse(a.expires_at) - clock() > MINUTE)
      return { provider, token: seal.open(a.access_token), account: a.account };
    try {
      const t = await provider.refresh(seal.open(a.refresh_token));
      run(
        "UPDATE calendar_accounts SET access_token = ?, expires_at = ?, refresh_token = COALESCE(?, refresh_token), error = NULL WHERE user_id = ?",
        seal.seal(t.accessToken),
        iso(t.expiresAt),
        t.refreshToken ? seal.seal(t.refreshToken) : null,
        userId,
      );
      return { provider, token: t.accessToken, account: a.account };
    } catch (err) {
      const reconnect = err instanceof CalendarError && err.reconnect;
      run(
        "UPDATE calendar_accounts SET error = ? WHERE user_id = ?",
        reconnect ? "Connect the calendar again: the provider no longer accepts CRM's access." : String((err as Error).message),
        userId,
      );
      throw new CrmError(502, "link-failed", `The calendar could not be read: ${(err as Error).message}`);
    }
  }

  async function calendarCall<T>(userId: string, fn: (p: CalendarProvider, token: string, account: string) => Promise<T>): Promise<T> {
    const a = await access(userId);
    try {
      const r = await fn(a.provider, a.token, a.account);
      run("UPDATE calendar_accounts SET ok_at = ?, error = NULL WHERE user_id = ?", iso(), userId);
      return r;
    } catch (err) {
      if (err instanceof CalendarError && err.status === 401) {
        // The access token was refused before its time: refresh once and try again.
        run("UPDATE calendar_accounts SET expires_at = NULL WHERE user_id = ?", userId);
        const b = await access(userId);
        return fn(b.provider, b.token, b.account);
      }
      run("UPDATE calendar_accounts SET error = ? WHERE user_id = ?", String((err as Error).message).slice(0, 300), userId);
      throw err;
    }
  }

  // ------------------------------------------------------------------ free times

  const mustLink = (id: string): MeetingLink => {
    const l = crm.config()?.meetingLinks.find((x) => x.id === id);
    if (!l) throw notFound("The meeting link");
    return l;
  };

  /** Held and confirmed bookings of the member that block time, with their buffers. */
  const blocked = (ownerEmail: string, from: number, to: number) =>
    q<{ block_from: string; block_to: string }>(
      "SELECT block_from, block_to FROM bookings WHERE owner_email = ? AND state IN ('held', 'confirmed') AND block_to > ? AND block_from < ?",
      ownerEmail,
      iso(from),
      iso(to),
    ).map((b) => ({ start: Date.parse(b.block_from), end: Date.parse(b.block_to) }));

  async function busyOf(m: Member, from: number, to: number, fresh: boolean) {
    const c = busyCache.get(m.email);
    if (!fresh && c && clock() - c.at < BUSY_CACHE && c.from <= from && c.to >= to) return c.busy;
    const busy = await calendarCall(m.id, (p, token, account) => p.busy(token, account, from, to));
    busyCache.set(m.email, { at: clock(), from, to, busy });
    return busy;
  }

  function candidates(l: MeetingLink) {
    const from = clock() + l.noticeMinutes * MINUTE;
    const to = clock() + l.daysAhead * 86_400_000;
    const step = Math.min(l.minutes, 30) * MINUTE;
    const out: Array<{ start: number; end: number }> = [];
    for (const [a, b] of intervals(l.hours, clock())) {
      if (a >= to) break;
      for (let s = a; s + l.minutes * MINUTE <= b; s += step) if (s >= from && s < to) out.push({ start: s, end: s + l.minutes * MINUTE });
      if (out.length > 2000) break;
    }
    return { from, to, list: out };
  }

  const overlaps = (s: { start: number; end: number }, buffer: number, busy: Array<{ start: number; end: number }>) =>
    busy.some((b) => b.start < s.end + buffer && b.end > s.start - buffer);

  async function freeSlots(l: MeetingLink, fresh = false) {
    const m = member(l.owner);
    if (!m || !accountOf(m.id)) throw new CrmError(409, "not-available", "This meeting link has no calendar to read free times from yet.");
    const { from, to, list } = candidates(l);
    const buffer = l.bufferMinutes * MINUTE;
    const busy = [...(await busyOf(m, from - buffer, to + buffer, fresh)), ...blocked(l.owner, from - buffer, to + buffer)];
    return { member: m, slots: list.filter((s) => !overlaps(s, buffer, busy)) };
  }

  function linkOut(l: MeetingLink) {
    const m = member(l.owner);
    const a = m ? accountOf(m.id) : undefined;
    return {
      id: l.id,
      name: l.name,
      url: `${opts.publicUrl}/book/${l.id}`,
      owner: m ? { id: m.id, name: m.name, email: m.email } : { id: null, name: l.owner, email: l.owner },
      minutes: l.minutes,
      hours: linkHours(l),
      timeZone: l.hours.timeZone,
      bufferMinutes: l.bufferMinutes,
      noticeMinutes: l.noticeMinutes,
      daysAhead: l.daysAhead,
      pipeline: l.pipeline,
      stage: l.stage,
      online: l.online,
      calendar: a ? { provider: a.provider, account: a.account, error: a.error } : null,
    };
  }

  /** GET /api/v1/public/meetings/{id}: the link and its free times, for the booking page. */
  async function publicSlots(id: string) {
    const l = mustLink(id);
    const { member: m, slots } = await freeSlots(l);
    return {
      id: l.id,
      name: l.name,
      owner: m.name,
      minutes: l.minutes,
      timeZone: l.hours.timeZone,
      slots: slots.map((s) => ({ start: iso(s.start), end: iso(s.end) })),
    };
  }

  // ------------------------------------------------------------------ booking

  async function book(id: string, raw: unknown) {
    const l = mustLink(id);
    const b = body(raw, ["start", "name", "email", "company", "note", "website"]);
    // A field people never see: what fills it is a bot.
    if (typeof b.website === "string" && b.website.trim()) throw bad("This booking cannot be taken.");
    const name = text(b.name, "name", 120);
    const email = optEmail(b.email);
    if (!email) throw bad("email is your email address; the invitation goes there.");
    const company = optText(b.company, "company", 120) ?? null;
    const note = optText(b.note, "note", 1000) ?? null;
    const start = typeof b.start === "string" ? Date.parse(b.start) : NaN;
    if (Number.isNaN(start)) throw bad("start is one of the free times, as a date-time.");

    // The calendar, read fresh: the time must still be free there and in the link's hours.
    const { member: m, slots } = await freeSlots(l, true);
    const slot = slots.find((s) => s.start === start);
    if (!slot) throw new CrmError(409, "conflict", "That time is no longer free. Pick another.");
    const buffer = l.bufferMinutes * MINUTE;

    // The hold: checked and written in one transaction, so two requests for the same time cannot both get it.
    const bookingId = randomUUID();
    tx(() => {
      run("UPDATE bookings SET state = 'failed', error = 'Not confirmed in time.' WHERE state = 'held' AND created_at < ?", iso(clock() - HOLD));
      const clash = one(
        "SELECT id FROM bookings WHERE owner_email = ? AND state IN ('held', 'confirmed') AND block_to > ? AND block_from < ?",
        l.owner,
        iso(slot.start - buffer),
        iso(slot.end + buffer),
      );
      if (clash) {
        crm.count(crm.counters.bookings, "taken");
        throw new CrmError(409, "conflict", "That time was just taken. Pick another.");
      }
      run(
        `INSERT INTO bookings (id, link, owner_email, start_at, end_at, block_from, block_to, state, name, email, company, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?)`,
        bookingId,
        l.id,
        l.owner,
        iso(slot.start),
        iso(slot.end),
        iso(slot.start - buffer),
        iso(slot.end + buffer),
        name,
        email,
        company,
        note,
        iso(),
      );
    });

    let event;
    try {
      event = await calendarCall(m.id, (p, token) =>
        p.createEvent(token, {
          start: slot.start,
          end: slot.end,
          title: company ? `${l.name}: ${name}, ${company}` : `${l.name}: ${name}`,
          description: [`Booked through ${opts.publicUrl}/book/${l.id}`, `${name} <${email}>${company ? `, ${company}` : ""}`, note].filter(Boolean).join("\n"),
          attendee: { name, email },
          timeZone: l.hours.timeZone,
          online: l.online,
          requestId: bookingId,
        }),
      );
    } catch (err) {
      run("UPDATE bookings SET state = 'failed', error = ? WHERE id = ?", String((err as Error).message).slice(0, 300), bookingId);
      crm.count(crm.counters.bookings, "failed");
      log("warn", "booking not made: the calendar did not take the event", { link: l.id, error: String(err) });
      throw new CrmError(502, "link-failed", "The calendar did not take the meeting. Try again in a minute.");
    }

    busyCache.delete(l.owner);
    const made = tx(() => {
      const r = crm.fromBooking({
        link: l.id,
        pipeline: l.pipeline,
        stage: l.stage,
        owner: { id: m.id, name: m.name },
        name,
        email,
        company,
        note,
        start: iso(slot.start),
        joinUrl: event.joinUrl,
        title: l.name,
      });
      run(
        "UPDATE bookings SET state = 'confirmed', contact_id = ?, deal_id = ?, made = ?, event_id = ?, join_url = ? WHERE id = ?",
        r.contact,
        r.deal,
        `${r.made}:${r.stage}`,
        event.id,
        event.joinUrl,
        bookingId,
      );
      return r;
    });
    crm.count(crm.counters.bookings, "confirmed");
    return {
      booking: { id: bookingId, start: iso(slot.start), end: iso(slot.end), joinUrl: event.joinUrl, owner: m.name, timeZone: l.hours.timeZone },
      contact: made.contact,
      deal: made.deal,
      made: made.made,
    };
  }

  function bookingOut(b: BookingRow) {
    const [made, stage] = (b.made ?? "").split(":");
    return {
      id: b.id,
      link: b.link,
      start: b.start_at,
      end: b.end_at,
      state: b.state,
      name: b.name,
      email: b.email,
      company: b.company,
      note: b.note,
      contact: b.contact_id,
      deal: b.deal_id,
      made: made === "created" || made === "added" ? { what: made, stage: stage ?? null } : null,
      joinUrl: b.join_url,
      error: b.error,
      createdAt: b.created_at,
    };
  }

  function bookings(query: URLSearchParams) {
    const link = query.get("link");
    return q<BookingRow>(
      "SELECT * FROM bookings WHERE (? IS NULL OR link = ?) AND state != 'held' AND start_at >= ? ORDER BY start_at LIMIT 200",
      link,
      link,
      iso(clock() - 30 * 86_400_000),
    ).map(bookingOut);
  }

  async function cancel(who: Actor, id: string) {
    const b = one<BookingRow>("SELECT * FROM bookings WHERE id = ?", id);
    if (!b) throw notFound("The booking");
    const m = member(b.owner_email);
    if (m?.id !== who.id && !atLeast(who.role, "admin")) throw new CrmError(403, "forbidden", "Only the meeting's owner or an admin cancels it.");
    if (b.state !== "confirmed") throw new CrmError(409, "conflict", `The booking is ${b.state}.`);
    if (m && b.event_id) {
      try {
        await calendarCall(m.id, (p, token) => p.cancelEvent(token, b.event_id!));
      } catch (err) {
        throw new CrmError(502, "link-failed", `The calendar did not cancel the meeting: ${(err as Error).message}`);
      }
    }
    run("UPDATE bookings SET state = 'cancelled' WHERE id = ?", id);
    busyCache.delete(b.owner_email);
    return bookingOut(one<BookingRow>("SELECT * FROM bookings WHERE id = ?", id)!);
  }

  return {
    providers,
    calendarState,
    connect,
    callback,
    disconnect,
    links: () => crm.config()?.meetingLinks.map(linkOut) ?? [],
    link: (id: string) => linkOut(mustLink(id)),
    mustLink,
    publicSlots,
    book,
    bookings,
    cancel,
    secretsInClear: !opts.secretsKey,
  };
}

export type Meetings = ReturnType<typeof createMeetings>;
