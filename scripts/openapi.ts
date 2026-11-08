// Writes openapi.json (ADR 0014, 0024). Run `npm run openapi` after changing the API; a test fails when the file is out
// of date. Sign-in routes come from @openasy/auth and are merged in when the description is served.
import { readFileSync, writeFileSync } from "node:fs";

type S = Record<string, unknown>;
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const bool = { type: "boolean" };
const dt = { type: "string", format: "date-time" };
const day = { type: "string", format: "date", examples: ["2026-11-28"] };
const nul = (s: S) => ({ anyOf: [s, { type: "null" }] });
const arr = (s: S) => ({ type: "array", items: s });
const obj = (properties: Record<string, S>, required = Object.keys(properties), extra?: boolean) => ({
  type: "object",
  required,
  properties,
  ...(extra === false && { additionalProperties: false }),
});
const map = { type: "object" };

const problem = { $ref: "#/components/responses/Problem" };
const ok = (schema: S, description = "OK") => ({ description, content: { "application/json": { schema } } });
const SECURE = [{ session: [] }, { apiToken: [] }, { adminToken: [] }];
const id = (what: string) => [{ name: "id", in: "path", required: true, description: `The ${what}'s id.`, schema: str }];
const query = (name: string, description: string, schema: S = str) => ({ name, in: "query", required: false, description, schema });
const json = (schema: S) => ({ required: true, content: { "application/json": { schema } } });

/** An operation that needs a role (ADR 0003), with the refusals every such operation can answer. */
function op(role: "viewer" | "editor" | "admin", o: S & { responses: Record<string, unknown> }) {
  return {
    ...o,
    security: SECURE,
    "x-openasy-role": role,
    description: [o.description, `Needs the ${role} role.`].filter(Boolean).join("\n\n"),
    responses: { ...o.responses, "401": problem, "403": problem },
  };
}
const pub = (o: S & { responses: Record<string, unknown> }) => ({ ...o, security: [] });

const Owner = nul(obj({ id: str, name: str }));
const Ref = (extra: Record<string, S> = {}) => nul(obj({ id: str, name: str, ...extra }));
const Plan = nul(obj({ id: str, name: str }));

const Company = obj({
  id: str,
  name: str,
  domain: nul(str),
  sector: nul(str),
  city: nul(str),
  plan: Plan,
  planRenews: nul(day),
  users: nul(int),
  owner: Owner,
  contacts: int,
  openDeals: int,
  openValue: num,
  createdAt: dt,
  updatedAt: dt,
  canEdit: { type: "boolean", description: "Whether the caller may change it: admins always, editors when they own it or nobody does." },
});
const Contact = obj({
  id: str,
  name: str,
  email: nul(str),
  phone: nul(str),
  title: nul(str),
  company: Ref(),
  owner: Owner,
  source: str,
  openDeals: int,
  createdAt: dt,
  updatedAt: dt,
  canEdit: bool,
});
const Deal = obj({
  id: str,
  name: str,
  pipeline: str,
  stage: obj({
    id: str,
    name: str,
    probability: { type: "number", description: "The share of the value the forecast counts: the stage's while open, 100 won, 0 lost." },
    inFile: bool,
  }),
  status: { type: "string", enum: ["open", "won", "lost"] },
  value: { type: "number", description: "In the currency, without KDV." },
  weighted: { type: "number", description: "value times the stage's probability." },
  currency: str,
  company: Ref(),
  contact: nul(obj({ id: str, name: str, email: nul(str) })),
  owner: Owner,
  expectedClose: nul(day),
  forecastMonth: nul({
    type: "string",
    examples: ["2026-11"],
    description: "The month the forecast counts it in: when won, or its expected close (this month when that has passed); null for none.",
  }),
  overdue: bool,
  source: str,
  sourceName: str,
  sourceDetail: nul(str),
  reason: nul(str),
  reasonNote: nul(str),
  closedAt: nul(dt),
  stageEnteredAt: dt,
  lastActivityAt: dt,
  quietDays: int,
  stale: { type: "boolean", description: "Open, and no activity for longer than its stage's stale_after." },
  staleAfter: nul(int),
  createdAt: dt,
  updatedAt: dt,
  canEdit: bool,
});
const Activity = obj({
  id: str,
  kind: { type: "string", enum: ["call", "meeting", "email", "note", "system"] },
  text: str,
  at: dt,
  by: obj({ id: nul(str), name: str }),
  deal: Ref(),
  contact: Ref(),
  company: Ref(),
  event: nul(str),
  data: nul(map),
});
const Task = obj({
  id: str,
  text: str,
  due: day,
  time: nul(str),
  overdue: bool,
  dueToday: bool,
  deal: nul(obj({ id: str, name: str, company: nul(str) })),
  contact: Ref(),
  owner: Owner,
  remindAt: nul(dt),
  remindedAt: nul(dt),
  doneAt: nul(dt),
  doneBy: nul(str),
  createdAt: dt,
  createdBy: str,
});
const Quote = obj({
  id: str,
  number: { type: "string", examples: ["Q-2026-118"] },
  deal: str,
  state: { type: "string", enum: ["draft", "sent", "accepted", "declined"] },
  currency: str,
  vat: { type: "number", description: "KDV, 0 to 100, as the file set it when the quote was made." },
  validUntil: day,
  notes: nul(str),
  lines: arr(obj({ item: str, quantity: num, unitPrice: num, discount: num, total: num })),
  subtotal: { type: "number", description: "Without KDV." },
  vatAmount: num,
  total: { type: "number", description: "With KDV." },
  createdAt: dt,
  createdBy: str,
  sentAt: nul(dt),
  decidedAt: nul(dt),
  pdf: str,
});
const Line = obj({ item: str, quantity: num, unitPrice: num, discount: num }, ["item", "unitPrice"]);
const Booking = obj({
  id: str,
  link: str,
  start: dt,
  end: dt,
  state: { type: "string", enum: ["confirmed", "cancelled", "failed"] },
  name: str,
  email: str,
  company: nul(str),
  note: nul(str),
  contact: nul(str),
  deal: nul(str),
  made: nul(obj({ what: { type: "string", enum: ["created", "added"] }, stage: nul(str) })),
  joinUrl: nul(str),
  error: nul(str),
  createdAt: dt,
});
const MeetingLink = obj({
  id: str,
  name: str,
  url: str,
  owner: obj({ id: nul(str), name: str, email: str }),
  minutes: int,
  hours: str,
  timeZone: str,
  bufferMinutes: int,
  noticeMinutes: int,
  daysAhead: int,
  pipeline: str,
  stage: str,
  online: bool,
  calendar: nul(obj({ provider: { type: "string", enum: ["google", "microsoft"] }, account: str, error: nul(str) })),
});

const schemas: Record<string, S> = {
  Problem: obj(
    {
      type: { type: "string", format: "uri" },
      title: str,
      status: int,
      code: {
        type: "string",
        description: "Stable; match on this.",
        enum: [
          "invalid-token",
          "invalid-json",
          "invalid-body",
          "forbidden",
          "not-found",
          "conflict",
          "not-linked",
          "not-available",
          "link-failed",
          "rate-limited",
          "payload-too-large",
          "internal-error",
          "unauthenticated",
          "invalid-credentials",
          "mfa-required",
          "mfa-setup-required",
          "cross-site",
        ],
      },
      detail: str,
    },
    ["type", "title", "status", "code"],
  ),
  Status: obj({ status: str }),
  Version: obj({ product: { const: "crm" }, version: str }),
  ProductList: obj({ products: arr(obj({ id: str, url: str })) }),
  Summary: obj({ tasksDue: int, tasksOpen: int, stale: int, file: nul(map) }),
  Settings: obj({ file: nul(map), yaml: str, config: nul(map) }),
  Team: obj({ members: arr(obj({ id: str, name: str, email: str })) }),
  Integrations: obj({ audience: map, messages: map, mail: map }),
  Report: obj({
    pipeline: str,
    currency: str,
    month: str,
    open: obj({ count: int, value: num, noCloseDate: int }),
    forecast: arr(obj({ month: str, won: num, weighted: num, total: num, deals: int, overdue: int })),
    won: obj({ count: int, value: num, deals: arr(map) }),
    lost: obj({ count: int, value: num, deals: arr(map) }),
    winRate: obj({ days: int, won: int, lost: int, rate: nul(num), before: nul(num) }),
    stale: int,
    history: arr(obj({ month: str, won: num, lost: num, wonCount: int, lostCount: int })),
    lostReasons: arr(obj({ reason: str, count: int, value: num })),
    wonReasons: arr(obj({ reason: str, count: int, value: num })),
    stages: arr(
      obj({ id: str, name: str, probability: num, staleAfter: nul(int), open: int, value: num, weighted: num, stale: int, avgDays: nul(num), left: int }),
    ),
    owners: arr(obj({ owner: Owner, deals: int, value: num, weighted: num, forecast: num, stale: int, won: num })),
  }),
  Company,
  CompanyList: obj({ companies: arr(ref("Company")) }),
  CompanyDetail: { allOf: [ref("Company"), obj({ people: arr(ref("Contact")), deals: arr(ref("Deal")), activities: arr(ref("Activity")) })] },
  CompanyInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: str,
      domain: nul(str),
      sector: nul(str),
      city: nul(str),
      plan: nul({ type: "string", description: "A plan id from the file." }),
      planRenews: nul(day),
      users: nul(int),
      owner: nul({ type: "string", description: "A member's id or email." }),
    },
  },
  Contact,
  ContactList: obj({ contacts: arr(ref("Contact")) }),
  ContactDetail: { allOf: [ref("Contact"), obj({ deals: arr(ref("Deal")), activities: arr(ref("Activity")), tasks: arr(ref("Task")) })] },
  ContactInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: str,
      email: nul(str),
      phone: nul(str),
      title: nul(str),
      company: nul(str),
      companyName: nul({ type: "string", description: "Found by name, or made." }),
      owner: nul(str),
    },
  },
  Deal,
  DealList: obj({ deals: arr(ref("Deal")) }),
  DealDetail: {
    allOf: [
      ref("Deal"),
      obj({
        companyDetail: nul(ref("Company")),
        contactDetail: nul(ref("Contact")),
        history: arr(obj({ stage: str, name: str, enteredAt: dt, leftAt: nul(dt), by: nul(str) })),
        timeInStage: arr(obj({ stage: str, days: num })),
        activities: arr(ref("Activity")),
        tasks: arr(ref("Task")),
        quotes: arr(ref("Quote")),
        sequences: arr(obj({ id: str, name: str })),
        lostReasons: arr(str),
        wonReasons: arr(str),
      }),
    ],
  },
  DealInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: str,
      pipeline: str,
      stage: str,
      value: num,
      company: nul(str),
      companyName: nul(str),
      contact: nul(str),
      owner: nul(str),
      expectedClose: nul(day),
      source: str,
    },
  },
  Activity,
  ActivityList: obj({ activities: arr(ref("Activity")) }),
  Task,
  TaskList: obj({ tasks: arr(ref("Task")) }),
  Quote,
  ImportResult: obj({
    kind: { type: "string", enum: ["companies", "contacts", "deals"] },
    rows: int,
    created: int,
    updated: int,
    skipped: int,
    errors: arr(obj({ row: int, message: str })),
    ignoredColumns: arr(str),
    dryRun: bool,
  }),
  MeetingLink,
  MeetingLinkList: obj({ links: arr(ref("MeetingLink")) }),
  Booking,
  BookingList: obj({ bookings: arr(ref("Booking")) }),
  CalendarState: obj({
    available: arr(obj({ provider: { type: "string", enum: ["google", "microsoft"] }, ready: bool })),
    connected: nul(obj({ provider: { type: "string", enum: ["google", "microsoft"] }, account: str, connectedAt: dt, okAt: nul(dt), error: nul(str) })),
  }),
  PublicSlots: obj({ id: str, name: str, owner: str, minutes: int, timeZone: str, slots: arr(obj({ start: dt, end: dt })) }),
  BookingRequest: obj({ start: dt, name: str, email: str, company: str, note: str }, ["start", "name", "email"]),
  BookingMade: obj({
    booking: obj({ id: str, start: dt, end: dt, joinUrl: nul(str), owner: str, timeZone: str }),
    contact: str,
    deal: str,
    made: {
      type: "string",
      enum: ["created", "added"],
      description: "created: a new deal in the link's stage; added: to the contact's open deal in that pipeline.",
    },
  }),
  AudienceProfile: obj({
    linked: bool,
    found: bool,
    url: nul(str),
    profile: nul(
      obj({
        id: str,
        pages: arr(obj({ path: str, views: int })),
        recent: arr(obj({ at: str, source: str, type: str, text: nul(str) })),
        traits: map,
      }),
    ),
  }),
  SequenceStarted: obj({ sequence: str, event: str, queued: bool }),
  // Helpdesk's contract, exactly as helpdesk/openapi.json defines CrmLookup, CrmContact and CrmDeal.
  CrmContact: obj(
    {
      id: str,
      name: str,
      email: str,
      title: nul(str),
      company: nul(obj({ name: str, users: nul(int) }, ["name", "users"], false)),
      plan: nul(obj({ id: str, name: str, renews: nul(str) }, ["id", "name", "renews"], false)),
      owner: nul(obj({ name: str, email: nul(str) }, ["name", "email"], false)),
      url: nul(str),
    },
    undefined,
    false,
  ),
  CrmDeal: obj(
    { id: str, name: str, amount: nul(num), currency: nul(str), stage: nul(str), status: { type: "string", enum: ["open", "won", "lost"] }, url: nul(str) },
    undefined,
    false,
  ),
  CrmLookup: {
    ...obj({ contact: ref("CrmContact"), deals: arr(ref("CrmDeal")) }, ["contact"]),
    description: "What Helpdesk reads: the contact with exactly this email, their company's plan (whose id Helpdesk routes and sets SLAs by), owner and deals.",
  },
  // Live Chat's contract (CrmLeadRequest in live-chat/openapi.json), and what forms and the API may send too.
  LeadRequest: {
    type: "object",
    required: ["external_id"],
    additionalProperties: false,
    description:
      "Live Chat sends exactly its CrmLeadRequest: external_id, source live-chat, name, email, page, title, owner, referrer, utm, pages, transcript and chat_url. Forms and your own systems may send phone, company, value and message too.",
    properties: {
      external_id: { type: "string", maxLength: 200, description: "The same id opens one lead, however often it is sent." },
      source: { type: "string", examples: ["live-chat", "forms", "api"] },
      name: nul(str),
      email: nul(str),
      phone: nul(str),
      company: nul(str),
      page: nul(str),
      title: nul({ type: "string", description: "The lead's deal name, up to 120 characters (the first line is kept)." }),
      value: nul(num),
      owner: nul(obj({ name: str, email: nul(str) }, [])),
      referrer: nul(str),
      utm: nul(obj({ source: nul(str), medium: nul(str), campaign: nul(str) }, [])),
      pages: arr(obj({ at: str, path: str }, [])),
      transcript: arr(obj({ from: str, name: str, at: str, text: str }, [])),
      chat_url: nul(str),
      message: nul(str),
    },
  },
  LeadCreated: obj({ lead: obj({ id: { type: "string", description: "The deal's id." }, url: str, contact: nul(str), created: bool }) }),
  // Audience's erasure contract (the erasure webhook in audience/openapi.json).
  ErasureRequest: obj({ reference: str, product: { const: "audience" }, people: obj({ emails: arr(str), phones: arr(str), userIds: arr(str) }) }),
  ErasureAnswer: obj({ status: { type: "string", enum: ["done", "waiting"] }, deleted: int, detail: str }, ["status"]),
};

const listQ = [query("q", "Part of a name, email, city or sector."), query("company", "Only this company's (contacts).")];

const paths: Record<string, S> = {
  "/api/v1/version": { get: pub({ operationId: "version", tags: ["Product"], summary: "Product and version", responses: { "200": ok(ref("Version")) } }) },
  "/api/v1/products": {
    get: op("viewer", { operationId: "products", tags: ["Product"], summary: "The install's other products", responses: { "200": ok(ref("ProductList")) } }),
  },
  "/api/v1/summary": {
    get: op("viewer", {
      operationId: "summary",
      tags: ["Product"],
      summary: "The caller's tasks due and stale deals",
      responses: { "200": ok(ref("Summary")) },
    }),
  },
  "/api/v1/settings": {
    get: op("viewer", { operationId: "settings", tags: ["Product"], summary: "The settings file as applied", responses: { "200": ok(ref("Settings")) } }),
  },
  "/api/v1/team": {
    get: op("viewer", { operationId: "team", tags: ["Product"], summary: "Members, who may own records", responses: { "200": ok(ref("Team")) } }),
  },
  "/api/v1/integrations": {
    get: op("viewer", {
      operationId: "integrations",
      tags: ["Product"],
      summary: "Audience, Messages and mail, and whether they answer",
      responses: { "200": ok(ref("Integrations")) },
    }),
  },
  "/api/v1/report": {
    get: op("viewer", {
      operationId: "report",
      tags: ["Reports"],
      summary: "Pipeline, forecast, won and lost, reasons, time in stage, by owner",
      description:
        "The forecast counts a won deal at its value in the month it was won, and an open deal at its value times its stage's probability in the month it is expected to close (this month when that date has passed).",
      parameters: [query("pipeline", "A pipeline id; the file's first by default."), query("owner", "me, or a member's id; everyone's by default.")],
      responses: { "200": ok(ref("Report")), "422": problem },
    }),
  },

  "/api/v1/companies": {
    get: op("viewer", {
      operationId: "listCompanies",
      tags: ["Companies"],
      summary: "Companies",
      parameters: listQ.slice(0, 1),
      responses: { "200": ok(ref("CompanyList")) },
    }),
    post: op("editor", {
      operationId: "createCompany",
      tags: ["Companies"],
      summary: "Add a company",
      requestBody: json(ref("CompanyInput")),
      responses: { "201": ok(ref("Company"), "Added; the caller owns it unless owner says otherwise."), "400": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/companies/{id}": {
    get: op("viewer", {
      operationId: "getCompany",
      tags: ["Companies"],
      summary: "A company with its contacts, deals and activities",
      parameters: id("company"),
      responses: { "200": ok(ref("CompanyDetail")), "404": problem },
    }),
    patch: op("editor", {
      operationId: "updateCompany",
      tags: ["Companies"],
      summary: "Change a company",
      description: "Editors change only what they own, or what nobody owns.",
      parameters: id("company"),
      requestBody: json(ref("CompanyInput")),
      responses: { "200": ok(ref("Company")), "404": problem, "409": problem, "422": problem },
    }),
    delete: op("editor", {
      operationId: "deleteCompany",
      tags: ["Companies"],
      summary: "Delete a company",
      parameters: id("company"),
      responses: { "204": { description: "Deleted." }, "404": problem },
    }),
  },

  "/api/v1/contacts": {
    get: op("viewer", {
      operationId: "listContacts",
      tags: ["Contacts"],
      summary: "Contacts",
      parameters: listQ,
      responses: { "200": ok(ref("ContactList")) },
    }),
    post: op("editor", {
      operationId: "createContact",
      tags: ["Contacts"],
      summary: "Add a contact",
      description: "An email belongs to one contact only. A new contact is sent to Audience as contact_created when it is linked.",
      requestBody: json(ref("ContactInput")),
      responses: { "201": ok(ref("Contact")), "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/contacts/{id}": {
    get: op("viewer", {
      operationId: "getContact",
      tags: ["Contacts"],
      summary: "A contact with their deals, activities and tasks",
      parameters: id("contact"),
      responses: { "200": ok(ref("ContactDetail")), "404": problem },
    }),
    patch: op("editor", {
      operationId: "updateContact",
      tags: ["Contacts"],
      summary: "Change a contact",
      parameters: id("contact"),
      requestBody: json(ref("ContactInput")),
      responses: { "200": ok(ref("Contact")), "404": problem, "409": problem, "422": problem },
    }),
    delete: op("editor", {
      operationId: "deleteContact",
      tags: ["Contacts"],
      summary: "Delete a contact",
      parameters: id("contact"),
      responses: { "204": { description: "Deleted." }, "404": problem },
    }),
  },

  "/api/v1/deals": {
    get: op("viewer", {
      operationId: "listDeals",
      tags: ["Deals"],
      summary: "Deals",
      parameters: [
        query("status", "open (default), won, lost or all."),
        query("pipeline", "A pipeline id."),
        query("owner", "me, none or a member's id."),
        query("q", "Part of the deal's, company's or contact's name."),
      ],
      responses: { "200": ok(ref("DealList")), "422": problem },
    }),
    post: op("editor", {
      operationId: "createDeal",
      tags: ["Deals"],
      summary: "Open a deal",
      requestBody: json(ref("DealInput")),
      responses: { "201": ok(ref("Deal")), "400": problem, "404": problem, "422": problem },
    }),
  },
  "/api/v1/deals/{id}": {
    get: op("viewer", {
      operationId: "getDeal",
      tags: ["Deals"],
      summary: "A deal with its history, activities, tasks and quotes",
      parameters: id("deal"),
      responses: { "200": ok(ref("DealDetail")), "404": problem },
    }),
    patch: op("editor", {
      operationId: "updateDeal",
      tags: ["Deals"],
      summary: "Change a deal",
      parameters: id("deal"),
      requestBody: json({
        type: "object",
        additionalProperties: false,
        properties: { name: str, value: num, company: nul(str), companyName: nul(str), contact: nul(str), owner: nul(str), expectedClose: nul(day) },
      }),
      responses: { "200": ok(ref("Deal")), "404": problem, "422": problem },
    }),
    delete: op("editor", {
      operationId: "deleteDeal",
      tags: ["Deals"],
      summary: "Delete a deal",
      parameters: id("deal"),
      responses: { "204": { description: "Deleted." }, "404": problem },
    }),
  },
  "/api/v1/deals/{id}/move": {
    post: op("editor", {
      operationId: "moveDeal",
      tags: ["Deals"],
      summary: "Move an open deal to another stage",
      description: "Sent to Audience as deal_stage_changed.",
      parameters: id("deal"),
      requestBody: json(obj({ stage: str, pipeline: str }, ["stage"])),
      responses: { "200": ok(ref("Deal")), "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/deals/{id}/won": {
    post: op("editor", {
      operationId: "winDeal",
      tags: ["Deals"],
      summary: "Mark a deal won",
      description: "reason, when the pipeline has won_reasons, is one of them. Sent to Audience as deal_won and to Messages.",
      parameters: id("deal"),
      requestBody: json(obj({ reason: str, note: str, value: num }, [])),
      responses: { "200": ok(ref("Deal")), "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/deals/{id}/lost": {
    post: op("editor", {
      operationId: "loseDeal",
      tags: ["Deals"],
      summary: "Mark a deal lost, with the reason",
      description: "reason is one of the pipeline's lost_reasons. Sent to Audience as deal_lost and to Messages.",
      parameters: id("deal"),
      requestBody: json(obj({ reason: str, note: str }, ["reason"])),
      responses: { "200": ok(ref("Deal")), "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/deals/{id}/reopen": {
    post: op("editor", {
      operationId: "reopenDeal",
      tags: ["Deals"],
      summary: "Reopen a won or lost deal",
      parameters: id("deal"),
      requestBody: json(obj({ stage: str }, [])),
      responses: { "200": ok(ref("Deal")), "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/deals/{id}/quotes": {
    post: op("editor", {
      operationId: "createQuote",
      tags: ["Quotes"],
      summary: "Make a quote for a deal",
      description: "Without lines, it starts from the deal's last quote, or one line with the deal's name and value. KDV is the file's quotes.vat.",
      parameters: id("deal"),
      requestBody: json(obj({ lines: arr(Line), notes: str, validUntil: day }, [])),
      responses: { "201": ok(ref("Quote")), "404": problem, "422": problem },
    }),
  },
  "/api/v1/deals/{id}/sequences": {
    post: op("editor", {
      operationId: "startSequence",
      tags: ["Deals"],
      summary: "Start a sales sequence in Messages for the deal's contact",
      description: "Posts the sequence's event to Messages' POST /api/v1/events, which starts the journey it triggers.",
      parameters: id("deal"),
      requestBody: json(obj({ sequence: str })),
      responses: { "202": ok(ref("SequenceStarted"), "Queued for Messages."), "404": problem, "409": problem, "422": problem },
    }),
  },
  "/api/v1/deals/{id}/audience": {
    get: op("viewer", {
      operationId: "dealAudience",
      tags: ["Deals"],
      summary: "What the deal's contact did, from Audience",
      parameters: id("deal"),
      responses: { "200": ok(ref("AudienceProfile")), "404": problem, "502": problem },
    }),
  },

  "/api/v1/activities": {
    get: op("viewer", {
      operationId: "listActivities",
      tags: ["Activities"],
      summary: "Activities",
      parameters: [query("deal", "A deal's id."), query("contact", "A contact's id."), query("company", "A company's id.")],
      responses: { "200": ok(ref("ActivityList")) },
    }),
    post: op("editor", {
      operationId: "logActivity",
      tags: ["Activities"],
      summary: "Log a call, meeting, email or note",
      requestBody: json(
        obj({ kind: { type: "string", enum: ["call", "meeting", "email", "note"] }, text: str, deal: str, contact: str, company: str, at: dt }, [
          "kind",
          "text",
        ]),
      ),
      responses: { "201": ok(ref("Activity")), "400": problem, "404": problem, "422": problem },
    }),
  },
  "/api/v1/activities/{id}": {
    delete: op("editor", {
      operationId: "deleteActivity",
      tags: ["Activities"],
      summary: "Remove a logged activity",
      parameters: id("activity"),
      responses: { "204": { description: "Removed." }, "404": problem, "409": problem },
    }),
  },

  "/api/v1/tasks": {
    get: op("viewer", {
      operationId: "listTasks",
      tags: ["Tasks"],
      summary: "Tasks",
      parameters: [query("owner", "me (default), all or a member's id."), query("state", "open (default), done or all.")],
      responses: { "200": ok(ref("TaskList")), "422": problem },
    }),
    post: op("editor", {
      operationId: "createTask",
      tags: ["Tasks"],
      summary: "Add a task",
      description: "Its reminder goes by email the morning it is due, at the file's tasks.remind_at, unless remind is false.",
      requestBody: json(obj({ text: str, due: day, time: str, deal: str, contact: str, owner: str, remind: bool }, ["text", "due"])),
      responses: { "201": ok(ref("Task")), "404": problem, "422": problem },
    }),
  },
  "/api/v1/tasks/{id}": {
    patch: op("editor", {
      operationId: "updateTask",
      tags: ["Tasks"],
      summary: "Change or complete a task",
      parameters: id("task"),
      requestBody: json(obj({ text: str, due: day, time: nul(str), owner: nul(str), done: bool }, [])),
      responses: { "200": ok(ref("Task")), "404": problem, "422": problem },
    }),
    delete: op("editor", {
      operationId: "deleteTask",
      tags: ["Tasks"],
      summary: "Delete a task",
      parameters: id("task"),
      responses: { "204": { description: "Deleted." }, "404": problem },
    }),
  },

  "/api/v1/quotes/{id}": {
    get: op("viewer", {
      operationId: "getQuote",
      tags: ["Quotes"],
      summary: "A quote",
      parameters: id("quote"),
      responses: { "200": ok(ref("Quote")), "404": problem },
    }),
    patch: op("editor", {
      operationId: "updateQuote",
      tags: ["Quotes"],
      summary: "Change a draft quote",
      parameters: id("quote"),
      requestBody: json(obj({ lines: arr(Line), notes: nul(str), validUntil: day }, [])),
      responses: { "200": ok(ref("Quote")), "404": problem, "409": problem, "422": problem },
    }),
    delete: op("editor", {
      operationId: "deleteQuote",
      tags: ["Quotes"],
      summary: "Delete a draft quote",
      parameters: id("quote"),
      responses: { "204": { description: "Deleted." }, "404": problem, "409": problem },
    }),
  },
  "/api/v1/quotes/{id}/send": {
    post: op("editor", {
      operationId: "sendQuote",
      tags: ["Quotes"],
      summary: "Send a quote, by email as PDF or marked sent",
      description: "A sent quote stays as it was sent. The deal's value becomes the quote's total without KDV.",
      parameters: id("quote"),
      requestBody: json(obj({ email: bool, to: str, message: str }, [])),
      responses: { "200": ok(ref("Quote")), "404": problem, "409": problem, "422": problem, "502": problem },
    }),
  },
  "/api/v1/quotes/{id}/accept": {
    post: op("editor", {
      operationId: "acceptQuote",
      tags: ["Quotes"],
      summary: "The customer accepted: the deal is won at the quote's value",
      parameters: id("quote"),
      responses: { "200": ok(ref("Quote")), "404": problem, "409": problem },
    }),
  },
  "/api/v1/quotes/{id}/decline": {
    post: op("editor", {
      operationId: "declineQuote",
      tags: ["Quotes"],
      summary: "The customer declined",
      parameters: id("quote"),
      responses: { "200": ok(ref("Quote")), "404": problem, "409": problem },
    }),
  },
  "/api/v1/quotes/{id}/pdf": {
    get: op("viewer", {
      operationId: "quotePdf",
      tags: ["Quotes"],
      summary: "A quote as PDF",
      description: "Lines without KDV, then the subtotal, the KDV and the total with KDV, each on its own line.",
      parameters: id("quote"),
      responses: { "200": { description: "The PDF.", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } }, "404": problem },
    }),
  },

  "/api/v1/import": {
    post: op("editor", {
      operationId: "importCsv",
      tags: ["Import"],
      summary: "Import companies, contacts or deals from CSV",
      description:
        "Comma or semicolon separated, with a header line. Companies match by name or domain, contacts by email; deals are added (or skipped when external_id was imported before). dryRun checks every row and changes nothing.",
      requestBody: json(obj({ kind: { type: "string", enum: ["companies", "contacts", "deals"] }, csv: str, dryRun: bool }, ["kind", "csv"])),
      responses: { "200": ok(ref("ImportResult")), "413": problem, "422": problem },
    }),
  },

  "/api/v1/meetings": {
    get: op("viewer", {
      operationId: "meetingLinks",
      tags: ["Meetings"],
      summary: "The file's meeting links",
      responses: { "200": ok(ref("MeetingLinkList")) },
    }),
  },
  "/api/v1/bookings": {
    get: op("viewer", {
      operationId: "listBookings",
      tags: ["Meetings"],
      summary: "Bookings, from 30 days ago",
      parameters: [query("link", "A meeting link's id.")],
      responses: { "200": ok(ref("BookingList")) },
    }),
  },
  "/api/v1/bookings/{id}/cancel": {
    post: op("editor", {
      operationId: "cancelBooking",
      tags: ["Meetings"],
      summary: "Cancel a booked meeting, in the calendar too",
      parameters: id("booking"),
      responses: { "200": ok(ref("Booking")), "404": problem, "409": problem, "502": problem },
    }),
  },
  "/api/v1/calendar": {
    get: op("viewer", {
      operationId: "calendar",
      tags: ["Meetings"],
      summary: "The caller's connected calendar",
      responses: { "200": ok(ref("CalendarState")) },
    }),
    delete: op("viewer", {
      operationId: "disconnectCalendar",
      tags: ["Meetings"],
      summary: "Disconnect the caller's calendar",
      responses: { "204": { description: "Disconnected." } },
    }),
  },
  "/api/v1/calendar/connect": {
    post: op("viewer", {
      operationId: "connectCalendar",
      tags: ["Meetings"],
      summary: "Start connecting Google Calendar or Microsoft 365",
      description: "Answers the provider's consent address; the browser goes there and comes back to /api/v1/calendar/callback.",
      requestBody: json(obj({ provider: { type: "string", enum: ["google", "microsoft"] } })),
      responses: { "200": ok(obj({ url: str })), "409": problem, "422": problem },
    }),
  },
  "/api/v1/calendar/callback": {
    get: op("viewer", {
      operationId: "calendarCallback",
      tags: ["Meetings"],
      summary: "Where the provider sends the browser back",
      parameters: [query("state", "What the connect call began with."), query("code", "The provider's code.")],
      responses: { "302": { description: "To /meetings?calendar=connected, refused, expired or failed." } },
    }),
  },
  "/api/v1/public/meetings/{id}": {
    get: pub({
      operationId: "publicSlots",
      tags: ["Booking"],
      summary: "A meeting link's free times",
      description:
        "Free times in the link's hours, from its owner's calendar, less held and confirmed bookings with their buffers. No sign-in; 60 calls a minute from one address.",
      parameters: id("meeting link"),
      responses: { "200": ok(ref("PublicSlots")), "404": problem, "409": problem, "429": problem, "502": problem },
    }),
  },
  "/api/v1/public/meetings/{id}/bookings": {
    post: pub({
      operationId: "book",
      tags: ["Booking"],
      summary: "Book a free time",
      description:
        "The calendar is read again; the time is held in one transaction so it is never booked twice, then the event is made with a Meet or Teams link and the contact and deal are found or made. 409 when the time is no longer free. No sign-in; 10 calls a minute from one address.",
      parameters: id("meeting link"),
      requestBody: json(ref("BookingRequest")),
      responses: { "201": ok(ref("BookingMade")), "400": problem, "404": problem, "409": problem, "422": problem, "429": problem, "502": problem },
    }),
  },

  "/api/v1/lookup": {
    get: op("viewer", {
      operationId: "lookup",
      tags: ["Contracts"],
      summary: "The customer by email, for Helpdesk",
      description: "Exactly the address, lowercased; no names or domains. 404 when no contact has it.",
      parameters: [{ name: "email", in: "query", required: true, schema: str }],
      responses: { "200": ok(ref("CrmLookup")), "404": problem, "422": problem },
    }),
  },
  "/api/v1/leads": {
    post: op("editor", {
      operationId: "openLead",
      tags: ["Contracts"],
      summary: "Open a lead, from Live Chat, a form or your systems",
      description:
        "A deal in the file's leads.stage, its contact found by email or made. The member whose email owner names owns it, else leads.owner, else nobody. The transcript and pages go in the deal's first activity.",
      requestBody: json(ref("LeadRequest")),
      responses: {
        "201": ok(ref("LeadCreated"), "A new lead."),
        "200": ok(ref("LeadCreated"), "The lead this external_id opened before."),
        "400": problem,
        "422": problem,
      },
    }),
  },
  "/api/v1/erasures": {
    post: op("admin", {
      operationId: "erase",
      tags: ["Contracts"],
      summary: "Delete a person on request, as Audience asks",
      description:
        "Every contact with one of the emails or phone numbers goes, with their activities and tasks; deals with no company that were theirs go too, others keep the company's side. Bookings and queued events with the identifiers go. The same reference answers the same again.",
      requestBody: json(ref("ErasureRequest")),
      responses: { "200": ok(ref("ErasureAnswer"), "Deleted."), "422": problem },
    }),
  },

  "/healthz": { get: pub({ operationId: "healthz", tags: ["Product"], summary: "Alive", responses: { "200": ok(ref("Status")) } }) },
  "/readyz": {
    get: pub({ operationId: "readyz", tags: ["Product"], summary: "Ready", responses: { "200": ok(ref("Status")), "503": ok(ref("Status"), "Not ready.") } }),
  },
  "/metrics": {
    get: pub({
      operationId: "metrics",
      tags: ["Product"],
      summary: "Prometheus metrics",
      responses: { "200": { description: "Metrics.", content: { "text/plain": { schema: str } } } },
    }),
  },
};

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const doc = {
  openapi: "3.1.0",
  info: {
    title: "OpenAsy CRM",
    version,
    description:
      "Companies, contacts and deals through the pipelines crm.yaml sets, with activities, tasks, quotes as PDF and meeting links. Viewers read everything; editors change what they own; admins change everything.",
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/" }],
  security: SECURE,
  paths,
  components: {
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "openasy_session" },
      apiToken: { type: "http", scheme: "bearer", description: "An API token made under Settings, API tokens." },
      adminToken: { type: "http", scheme: "bearer", description: "Tests only." },
    },
    responses: { Problem: { description: "A problem (RFC 9457).", content: { "application/problem+json": { schema: ref("Problem") } } } },
    schemas,
  },
};

export const OPENAPI = doc;
const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  writeFileSync(new URL("../openapi.json", import.meta.url), text);
  console.log("openapi.json written");
}
export const OPENAPI_TEXT = text;
