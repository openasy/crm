// What the parts of CRM share: the error the API turns into a problem, who does something, the database helpers and
// the checks that read a request's fields.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Role } from "@openasy/auth";

export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "not-linked"
  | "not-available"
  | "link-failed"
  | "rate-limited"
  | "payload-too-large"
  | "internal-error";

export class CrmError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly retryAfter?: number;
  constructor(status: number, code: ProblemCode, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Who does something: a signed-in member, an API token, or the tests' admin token. */
export interface Actor {
  id: string;
  name: string;
  role: Role;
}

export const bad = (message: string) => new CrmError(422, "invalid-body", message);
export const notFound = (what: string) => new CrmError(404, "not-found", `${what} does not exist.`);
export const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export const DAY = 86_400_000;
export const MINUTE = 60_000;

export function createStore(db: DatabaseSync, clock: () => number) {
  let depth = 0;
  return {
    db,
    clock,
    iso: (ms = clock()) => new Date(ms).toISOString(),
    q: <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as T[],
    one: <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).get(...args) as T | undefined,
    run: (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).run(...args),
    /**
     * Runs fn in one write transaction. BEGIN IMMEDIATE takes the write lock at once, so a check and the write that
     * follows it cannot be split by another writer, in this process or another on the same file.
     */
    tx<T>(fn: () => T): T {
      if (depth > 0) return fn();
      db.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      } finally {
        depth--;
      }
    },
  };
}
export type Store = ReturnType<typeof createStore>;

/** The body as a map, or a 422 that says what it takes. */
export function body(v: unknown, takes: string[]): Record<string, unknown> {
  if (!isObj(v)) throw bad(`The body is a JSON object with ${takes.join(", ")}.`);
  const extra = Object.keys(v).filter((k) => !takes.includes(k));
  if (extra.length) throw bad(`unknown ${extra.join(", ")}; it takes ${takes.join(", ")}.`);
  return v;
}

/** A required text field. */
export function text(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" || !v.trim() || v.trim().length > max) throw bad(`${field} is a text of 1 to ${max} characters.`);
  return v.trim();
}

/** A text field that may be left out (undefined), cleared (null or ""), or set. */
export function optText(v: unknown, field: string, max = 200): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || (typeof v === "string" && !v.trim())) return null;
  return text(v, field, max);
}

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
export function optEmail(v: unknown, field = "email"): string | null | undefined {
  const s = optText(v, field, 254);
  if (s === undefined || s === null) return s;
  if (!EMAIL.test(s)) throw bad(`${field} is an email address.`);
  return s.toLowerCase();
}

export function optDay(v: unknown, field: string): string | null | undefined {
  if (v === undefined || v === null || v === "") return v === undefined ? undefined : null;
  const ok =
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
    new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
  if (!ok) throw bad(`${field} is a day, YYYY-MM-DD.`);
  return v as string;
}

/** An amount in the currency's units, up to two decimals, as minor units: 45000.5 is 4500050. */
export function amount(v: unknown, field: string): number {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1e12 || Math.abs(Math.round(n * 100) - n * 100) > 1e-6)
    throw bad(`${field} is an amount of 0 or more, with at most two decimals.`);
  return Math.round(n * 100);
}

/** Phone numbers compared by their digits, with Turkey's leading 0 written as 90: 0532 000 00 12 is 905320000012. */
export function phoneKey(v: string | null | undefined): string | null {
  if (!v) return null;
  let d = v.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = `90${d.slice(1)}`;
  else if (d.length === 10 && d.startsWith("5")) d = `90${d}`;
  return d.length >= 7 ? d : null;
}

export const money = (minor: number) => Math.round(minor) / 100;
