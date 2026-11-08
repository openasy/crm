# crm

[![CI](https://github.com/openasy/crm/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/crm/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) CRM product: companies, contacts and deals through pipelines whose stages
and probabilities are set in a file, with tasks and reminders, calls, meetings and notes, quotes as PDF with KDV shown
separately, the forecast, won and lost with their reasons, time in each stage, and a meeting link people book from
that reads free times from Google Calendar or Microsoft 365. Linked to Audience, a lead's profile shows what they did
on the site. It does not sign quotes or write invoices.

```
crm.yaml ──▶ crm ◀── Live Chat, forms, your systems: POST /api/v1/leads
              │ ▲
              │ └── Helpdesk: GET /api/v1/lookup?email=   Audience: POST /api/v1/erasures
              ├──▶ Audience: POST /api/v1/events (source crm), and the profile on a deal
              ├──▶ Messages: POST /api/v1/events (sales sequences; won and lost)
              ├──▶ Google Calendar / Microsoft Graph: free/busy and the booked event (OAuth)
              └──▶ SMTP: task reminders, quotes as PDF
```

## Deals, the forecast and stale deals

A deal is in one stage of one pipeline, or won, or lost. Its value is in the file's `currency`, without KDV.

- **Forecast.** A deal counts at its value times its stage's probability, in the month it is expected to close. A won
  deal counts in full in the month it was won; a lost one counts nothing. An open deal whose expected close date has
  passed counts in the current month (it has not closed, so it is still expected) and is marked overdue. An open deal
  with no expected close date is in no month's forecast; the overview counts them.
- **Stale.** An open deal with no activity for longer than its stage's `stale_after` is stale for its owner: it is
  marked on the board and the deal, counted on the overview and the owner's Pipeline link, listed on their Tasks page
  and in their task reminder email when one goes out. Activity is anything done on the deal: a logged call, meeting,
  email or note, a stage change, a completed task, a quote, a booking. Won and lost deals are never stale.
- **Won and lost.** Lost needs a reason from the pipeline's `lost_reasons` (any text when the list is empty); won takes
  one from `won_reasons` when the file has them. A deal can be reopened.
- **Time in stage.** Every stage a deal enters and leaves is kept; the deal shows its days in each stage, and the
  overview the average of the stays that ended in the last 90 days.

## Ownership

Every company, contact and deal has at most one owner, a member. **Viewers** see everything. **Editors** change what
they own, and what has no owner yet (and so can take it); they can give their own records to someone else. **Admins**
change everything. Logging an activity, adding a task or a quote on a deal counts as changing it. A task can be changed
by its owner, the deal's owner or an admin. Roles are the members' roles under Members (ADR 0003), not set in the file.

## Quotes

A quote belongs to a deal and has lines (item, quantity, unit price, discount). A new quote starts from the deal's last
one, or one line with the deal's name and value. The KDV rate and the seller are taken from the file when the quote is
made. A draft is edited; once sent (by email with the PDF attached, or marked sent) it stays as it was and the deal's
value becomes the quote's total without KDV. Accepted wins the deal at that value. Numbers are `Q-<year>-<n>`.

The PDF is made on the server with [PDFKit](https://pdfkit.org) and DejaVu Sans embedded, so every Turkish letter is
drawn and can be searched and copied. Prices are without KDV; the subtotal, the KDV and the total with KDV are on lines
of their own. `quotes.language` writes it in Turkish, English or German; TRY is written TL (`45.000,00 TL`).

## Meeting links

Each link in the file belongs to a member (`owner`), who connects their Google Calendar or Microsoft 365 calendar on
the Meeting link page (OAuth, authorization code with offline access; register CRM with the provider with the redirect
`<CRM_PUBLIC_URL>/api/v1/calendar/callback`). CRM asks only for free/busy and event creation (Google
`calendar.freebusy` and `calendar.events`; Microsoft `Calendars.ReadWrite`, `User.Read`, `offline_access`); tokens are
encrypted with the product's key.

`/book/<id>` is a plain page with a form and no script, in English, Turkish or German by the browser's language. It
offers the link's `hours` in `time_zone`, from `notice` ahead up to `days_ahead`, less the calendar's busy times and
other bookings of the same owner, each with `buffer` around it. A booking:

1. reads the calendar's free/busy again, fresh, and refuses a time that is no longer free;
2. **holds the time**: in one write transaction (`BEGIN IMMEDIATE`) it checks that no held or confirmed booking of the
   owner overlaps the time with its buffers and inserts the hold. Of many requests for the same time, one gets it and
   the others are told it was just taken (409). A hold whose event was never made lets go after 10 minutes;
3. makes the event in the owner's calendar with the visitor as attendee and a Meet or Teams link;
4. finds or makes the contact (by email) and the company, and adds a meeting to the contact's open deal in the link's
   pipeline, or opens one in `creates_deal_in`.

The same is at `GET /api/v1/public/meetings/{id}` and `POST /api/v1/public/meetings/{id}/bookings` for your own pages.

## What other products call

**Helpdesk** asks `GET /api/v1/lookup?email=<address>` with a CRM token of the viewer role, and gets 200 with
`{ contact, deals }` (Helpdesk's `CrmLookup`) or 404. The address is matched exactly, lowercased. `contact.plan` is the
contact's company's plan (`plans` in the file, set on the company with its renewal date and seats); its `id` is what
Helpdesk's routing rules and `sla_by_plan` match. Deals are the contact's and their company's, open first, up to 20.

```json
{ "contact": { "id": "…", "name": "Gizem Avcı", "email": "gizem@avci.example", "title": "Finance lead",
               "company": { "name": "Avcı Lojistik", "users": 48 },
               "plan": { "id": "business", "name": "Business", "renews": "2026-12-31" },
               "owner": { "name": "Hakan Yıldız", "email": "hakan@example.com" }, "url": "https://crm.example.com/contacts/…" },
  "deals": [{ "id": "…", "name": "Renewal", "amount": 300000, "currency": "TRY", "stage": "Proposal", "status": "open", "url": "…" }] }
```

**Live Chat** opens a lead with `POST /api/v1/leads` and a token of the editor role, sending its `CrmLeadRequest`
(`external_id`, `source`, `name`, `email`, `page`, `title`, `owner`, `referrer`, `utm`, `pages`, `transcript`,
`chat_url`). CRM opens a deal in `leads.stage` named by the title, with the contact found by email or made, and puts
the transcript, the pages read and the campaign in its first activity. The member whose email `owner` names owns it,
else `leads.owner`, else nobody. It answers 201 `{ "lead": { "id", "url" } }`, and 200 with the same lead when the same
`external_id` comes again. Forms and your systems may call it too, with `phone`, `company`, `value` and `message`.

**Audience**, once `audience` is in the file, gets `contact_created`, `contact_changed`, `deal_opened`,
`deal_stage_changed`, `deal_won` and `deal_lost` at `POST /api/v1/events` with source `crm`, the contact's email, phone
and name, and the deal's name, stage, status, value and company as properties. Events wait in an outbox and are sent in
the background; a failure is tried again after 1, 2, 4 minutes and so on up to 6 hours, a refused token every 10
minutes, and an event is dropped after three days. Contacts without email or phone send nothing. On a deal, CRM shows
the contact's profile from `GET /api/v1/people?email=` and their timeline: pages viewed this month, and what else they
did. Audience's token needs the editor role (viewer is enough for the profile alone).

When a person is deleted in Audience, it calls `POST /api/v1/erasures` here with a CRM token of the admin role. Every
contact with one of the emails or phone numbers is deleted with their activities and tasks; a deal that had no company
and was theirs is deleted, other deals keep the company's side without the person; bookings and waiting events with
the identifiers go too. CRM answers 200 `{ "status": "done", "deleted": n }`, the same again for the same reference.
CRM never answers `waiting`: it keeps no invoices.

**Messages.** Messages has no sales sequence feature of its own; it has journeys started by an event
(`POST /api/v1/events`). A sequence in CRM's file names such an event: Start on a deal posts it for the deal's contact,
with `deal`, `company`, `owner`, `stage` and `first_name` as fields, and the journey that event triggers runs. Won and
lost deals post `deal_won` and `deal_lost`, so a journey whose goal is one of them lets the person go. Messages checks
consent before it sends.

## CSV import

Companies, contacts or deals, comma or semicolon separated (as Excel writes it in Turkish), with a header line.
Companies are matched by name or domain and contacts by email, and updated; deals are added, once per `external_id`.
Amounts may be written `108.000,00` or `108,000.00`, days `2026-11-28` or `28.11.2026`. **Check** runs every row and
changes nothing; rows with a mistake are listed and the others imported.

## The settings file

Everything but the records is in [config/crm.yaml](./config/crm.yaml), read at start and again within a minute of a
change, applied whole or not at all; a file with a mistake leaves the last good version in place. The UI shows it
read-only under Settings.

| Key | Default | |
| --- | --- | --- |
| `currency`, `time_zone` | `TRY`, `Europe/Istanbul` | |
| `pipelines.<id>` | one `sales` pipeline | `{ name, stages: [{ id, name, probability, stale_after }], lost_reasons, won_reasons }` |
| `plans` | | `<id>: <name>`: what companies are on; Helpdesk routes by the id |
| `leads` | the first stage | `{ stage, owner }`: where leads start (`stage` or `pipeline/stage`), and who owns a lead no member sent |
| `quotes` | 20%, 30d, `tr` | `{ vat, valid_for, language, seller: { name, address, tax_office, tax_number, email, phone }, terms }` |
| `tasks.remind_at` | `08:00` | Reminders go by email the morning a task is due, with the owner's stale deals |
| `mail` | | `{ host, port, security, user, password, from }`; `password` names a variable |
| `calendars` | | `google: { client_id, client_secret }`, `microsoft: { client_id, client_secret, tenant }`, each naming variables |
| `meeting_links.<id>` | | `{ name, owner, length, hours, buffer, notice, days_ahead, creates_deal_in, online }` |
| `audience` | | `{ url, token, events, profile }` |
| `messages` | | `{ url, token, sequences: { <id>: { name, event } } }` |

## Run

```bash
openssl rand -hex 32 > openasy-kek
$EDITOR config/crm.yaml
docker compose up -d
docker compose logs crm | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013).

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `CRM_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy; booking links and OAuth redirects use it |
| `CRM_CONFIG` | `/config/crm.yaml` | The settings file |
| the variables the file names | | The mail password, calendar client ids and secrets, Audience and Messages tokens |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher |
| `CRM_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key: sign-in secrets and calendar tokens |
| `CRM_DB` | `/data/crm.db` | SQLite file (WAL), on the `/data` volume |
| `CRM_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `CRM_HEADLESS` | `false` | `true` serves no team UI; the API and booking pages stay |
| `CRM_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in for the team, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. Metrics
include deals by status, stale deals, the outbox, events sent and dropped, reminders and bookings by result. The lookup's
email is not written to the request log. The API reference is at `/api/docs/`.

## Develop

```bash
npm install
npm test           # the file, the forecast, stale deals, ownership, tasks and reminders, quotes and the PDF read back,
                   # CSV, the Helpdesk, Live Chat and Audience contracts, calendars and bookings against fakes,
                   # SMTP against an in-process server, and every API response against openapi.json
npm run openapi    # writes openapi.json after an API change; a test fails while it is out of date
npm run dev        # the UI, with the API on :8080
```

What is tested against fakes only: Google's OAuth, Calendar free/busy and events, and Microsoft's identity platform
and Graph `getSchedule` and events are exercised through the real clients in `server/calendar.ts` against
`server/fakes.ts`, which answers in the shapes their documentation gives. The real services, consent screens, Meet and
Teams links, and Microsoft's handling of `transactionId` are not tested here. Audience's and Messages' event APIs are
also fakes here; SMTP is tested without TLS.

The team UI follows the CRM screens in the [ui](https://github.com/openasy/ui) Storybook. Its read-only Settings page
is rebuilt here from published components (`web/src/FileSettings.tsx`) until the shared page is in a published
`@openasy/ui`.

## Licence

AGPL-3.0 (ADR 0008).
