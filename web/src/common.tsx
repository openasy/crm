// What the pages share: data loading with the session, formatting money and dates, and small pieces of layout.
import { useAuth } from "@openasy/auth/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized } from "./api.ts";
import type { T } from "./i18n.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <R,>(path: string, init?: RequestInit): Promise<R> => {
      try {
        return await api<R>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

/** Loads a path when it changes; `reload` loads it again. undefined while loading, null when it failed. */
export function useLoad<R>(call: Call, path: string | null) {
  const [data, setData] = useState<R | null>();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    void call<R>(path).then(
      (d) => live && setData(d),
      () => live && setData(null),
    );
    return () => {
      live = false;
    };
  }, [call, path, n]);
  return [data, () => setN((x) => x + 1)] as const;
}

/** A status line after something was done, read out by screen readers. */
export function Notice({ children, tone = "success" }: { children: ReactNode; tone?: "success" | "danger" }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`mb-2.5 rounded-md px-3 py-2 text-sm text-fg ${tone === "danger" ? "bg-danger-soft" : "bg-success-soft"}`}
    >
      {children}
    </div>
  );
}

export function Code({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <pre aria-label={label} className="crm-code m-0 overflow-x-auto rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs leading-relaxed text-fg">
      {children}
    </pre>
  );
}

// ---------------------------------------------------------------- formatting

/** 45000 is "45,000 TL" in English and "45.000 TL" in Turkish; TRY is written TL, as people write it. */
export function money(n: number, currency = "TRY", locale?: string) {
  const v = new Intl.NumberFormat(locale, { maximumFractionDigits: Number.isInteger(n) ? 0 : 2, minimumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
  return `${v} ${currency === "TRY" ? "TL" : currency}`;
}

export const day = (d: string, locale?: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: "UTC" });
export const monthName = (m: string, locale?: string, long = false) =>
  new Date(`${m}-15T12:00:00Z`).toLocaleDateString(locale, { month: long ? "long" : "short", timeZone: "UTC" });
export const when = (iso: string, locale?: string) =>
  new Date(iso).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const time = (iso: string, locale?: string, timeZone?: string) =>
  new Date(iso).toLocaleString(locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone });

/** Today as YYYY-MM-DD in the browser's zone. */
export function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const host = (url: string) => URL.parse(url)?.host ?? url;

const SOURCES = ["manual", "import", "api", "live-chat", "forms", "meeting-link"] as const;
/** Where a deal or contact came from, in the page's language; a source the UI does not know is shown as it is. */
export function sourceLabel(t: T, id: string, fallback = id) {
  return (SOURCES as readonly string[]).includes(id) ? t(`source.${id as (typeof SOURCES)[number]}`) : fallback;
}
