// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export interface ProductLink {
  id: string;
  url: string;
}

export type ConfigFile = { path: string; appliedAt: string | null; error: string | null; warnings: string[] } | null;

export interface Stage {
  id: string;
  name: string;
  probability: number;
  staleDays: number | null;
}
export interface Pipeline {
  id: string;
  name: string;
  stages: Stage[];
  lostReasons: string[];
  wonReasons: string[];
}

export interface Config {
  currency: string;
  timeZone: string;
  pipelines: Pipeline[];
  plans: Array<{ id: string; name: string }>;
  leads: { pipeline: string; stage: string; owner: string | null };
  quotes: {
    vat: number;
    validDays: number;
    language: string;
    seller: { name: string; address: string | null; taxOffice: string | null; taxNumber: string | null; email: string | null; phone: string | null };
    terms: string | null;
  };
  tasks: { remindAt: string };
  mail: { host: string; port: number; security: string; from: string; password: string } | null;
  audience: { url: string; token: string; events: boolean; profile: boolean } | null;
  messages: { url: string; token: string; sequences: Array<{ id: string; name: string; event: string }> } | null;
}

export interface Settings {
  file: ConfigFile;
  yaml: string;
  config: Config | null;
}

export interface Summary {
  tasksDue: number;
  tasksOpen: number;
  stale: number;
  file: ConfigFile;
}

export interface Member {
  id: string;
  name: string;
  email: string;
}

type Owner = { id: string; name: string } | null;

export interface Company {
  id: string;
  name: string;
  domain: string | null;
  sector: string | null;
  city: string | null;
  plan: { id: string; name: string } | null;
  planRenews: string | null;
  users: number | null;
  owner: Owner;
  contacts: number;
  openDeals: number;
  openValue: number;
  canEdit: boolean;
}

export interface Contact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  company: { id: string; name: string } | null;
  owner: Owner;
  source: string;
  openDeals: number;
  canEdit: boolean;
}

export type Status = "open" | "won" | "lost";

export interface Deal {
  id: string;
  name: string;
  pipeline: string;
  stage: { id: string; name: string; probability: number; inFile: boolean };
  status: Status;
  value: number;
  weighted: number;
  currency: string;
  company: { id: string; name: string } | null;
  contact: { id: string; name: string; email: string | null } | null;
  owner: Owner;
  expectedClose: string | null;
  forecastMonth: string | null;
  overdue: boolean;
  source: string;
  sourceName: string;
  sourceDetail: string | null;
  reason: string | null;
  reasonNote: string | null;
  closedAt: string | null;
  stageEnteredAt: string;
  lastActivityAt: string;
  quietDays: number;
  stale: boolean;
  staleAfter: number | null;
  createdAt: string;
  canEdit: boolean;
}

export interface Activity {
  id: string;
  kind: "call" | "meeting" | "email" | "note" | "system";
  text: string;
  at: string;
  by: { id: string | null; name: string };
  deal: { id: string; name: string } | null;
  contact: { id: string; name: string } | null;
  event: string | null;
  data: Record<string, unknown> | null;
}

export interface Task {
  id: string;
  text: string;
  due: string;
  time: string | null;
  overdue: boolean;
  dueToday: boolean;
  deal: { id: string; name: string; company: string | null } | null;
  contact: { id: string; name: string } | null;
  owner: Owner;
  remindAt: string | null;
  doneAt: string | null;
}

export interface QuoteLine {
  item: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  total: number;
}

export interface Quote {
  id: string;
  number: string;
  state: "draft" | "sent" | "accepted" | "declined";
  currency: string;
  vat: number;
  validUntil: string;
  notes: string | null;
  lines: QuoteLine[];
  subtotal: number;
  vatAmount: number;
  total: number;
  sentAt: string | null;
  pdf: string;
}

export interface DealDetail extends Deal {
  companyDetail: Company | null;
  contactDetail: Contact | null;
  history: Array<{ stage: string; name: string; enteredAt: string; leftAt: string | null; by: string | null }>;
  timeInStage: Array<{ stage: string; days: number }>;
  activities: Activity[];
  tasks: Task[];
  quotes: Quote[];
  sequences: Array<{ id: string; name: string }>;
  lostReasons: string[];
  wonReasons: string[];
}

export interface CompanyDetail extends Company {
  people: Contact[];
  deals: Deal[];
  activities: Activity[];
}

export interface ContactDetail extends Contact {
  deals: Deal[];
  activities: Activity[];
  tasks: Task[];
}

export interface Report {
  pipeline: string;
  currency: string;
  month: string;
  open: { count: number; value: number; noCloseDate: number };
  forecast: Array<{ month: string; won: number; weighted: number; total: number; deals: number; overdue: number }>;
  won: { count: number; value: number; deals: Array<{ id: string; name: string; company: string | null; value: number }> };
  lost: { count: number; value: number; deals: Array<{ id: string; name: string; company: string | null; value: number; reason: string | null }> };
  winRate: { days: number; won: number; lost: number; rate: number | null; before: number | null };
  stale: number;
  history: Array<{ month: string; won: number; lost: number; wonCount: number; lostCount: number }>;
  lostReasons: Array<{ reason: string; count: number; value: number }>;
  stages: Array<{
    id: string;
    name: string;
    probability: number;
    staleAfter: number | null;
    open: number;
    value: number;
    weighted: number;
    stale: number;
    avgDays: number | null;
  }>;
  owners: Array<{ owner: Owner; deals: number; value: number; weighted: number; forecast: number; stale: number; won: number }>;
}

export interface AudienceProfile {
  linked: boolean;
  found: boolean;
  url: string | null;
  profile: {
    id: string;
    pages: Array<{ path: string; views: number }>;
    recent: Array<{ at: string; source: string; type: string; text: string | null }>;
    traits: Record<string, string | number | boolean>;
  } | null;
}

export interface MeetingLink {
  id: string;
  name: string;
  url: string;
  owner: { id: string | null; name: string; email: string };
  minutes: number;
  hours: string;
  timeZone: string;
  bufferMinutes: number;
  noticeMinutes: number;
  daysAhead: number;
  pipeline: string;
  stage: string;
  online: boolean;
  calendar: { provider: "google" | "microsoft"; account: string; error: string | null } | null;
}

export interface Booking {
  id: string;
  link: string;
  start: string;
  end: string;
  state: "confirmed" | "cancelled" | "failed";
  name: string;
  email: string;
  company: string | null;
  deal: string | null;
  made: { what: "created" | "added"; stage: string | null } | null;
  joinUrl: string | null;
  error: string | null;
}

export interface CalendarState {
  available: Array<{ provider: "google" | "microsoft"; ready: boolean }>;
  connected: { provider: "google" | "microsoft"; account: string; connectedAt: string; okAt: string | null; error: string | null } | null;
}

export interface PublicSlots {
  id: string;
  name: string;
  owner: string;
  minutes: number;
  timeZone: string;
  slots: Array<{ start: string; end: string }>;
}

type LinkState = { okAt: string | null; errorAt: string | null; error: string | null };
export interface Integrations {
  audience: LinkState & { linked: boolean; url: string | null; tokenSet: boolean; queued: number };
  messages: LinkState & {
    linked: boolean;
    url: string | null;
    tokenSet: boolean;
    queued: number;
    sequences: Array<{ id: string; name: string; event: string }>;
  };
  mail: LinkState & { configured: boolean; host: string | null };
}

export interface ImportResult {
  kind: string;
  rows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
  ignoredColumns: string[];
  dryRun: boolean;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
