// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  /** Deals by status: open, won, lost. */
  deals: Record<string, number>;
  /** Open deals with no activity for longer than their stage allows. */
  stale: number;
  /** Events waiting for Audience and Messages. */
  outbox: Record<string, number>;
  counters: { outbox: Map<string, number>; reminders: Map<string, number>; bookings: Map<string, number> };
  /** 1 when the settings file on disk could not be applied and an older version is in use. */
  fileError: boolean;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="crm",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_crm_deals Deals, by status.",
    "# TYPE openasy_crm_deals gauge",
    ...["open", "won", "lost"].map((s) => `openasy_crm_deals{status="${s}"} ${g.deals[s] ?? 0}`),
    "# HELP openasy_crm_stale_deals Open deals with no activity for longer than their stage allows.",
    "# TYPE openasy_crm_stale_deals gauge",
    `openasy_crm_stale_deals ${g.stale}`,
    "# HELP openasy_crm_outbox Events waiting to be sent, by product.",
    "# TYPE openasy_crm_outbox gauge",
    ...["audience", "messages"].map((t) => `openasy_crm_outbox{target="${t}"} ${g.outbox[t] ?? 0}`),
    "# HELP openasy_crm_events_total Events sent to Audience and Messages, and dropped after they were refused or too old.",
    "# TYPE openasy_crm_events_total counter",
    ...[...g.counters.outbox].map(([k, n]) => {
      const [target, result] = k.split(":");
      return `openasy_crm_events_total{target="${target}",result="${result}"} ${n}`;
    }),
    "# HELP openasy_crm_reminders_total Task reminders, by result.",
    "# TYPE openasy_crm_reminders_total counter",
    ...[...g.counters.reminders].map(([k, n]) => `openasy_crm_reminders_total{result="${k}"} ${n}`),
    "# HELP openasy_crm_bookings_total Bookings through meeting links, by result.",
    "# TYPE openasy_crm_bookings_total counter",
    ...[...g.counters.bookings].map(([k, n]) => `openasy_crm_bookings_total{result="${k}"} ${n}`),
    "# HELP openasy_crm_config_error 1 when the settings file could not be applied and its last good version is in use.",
    "# TYPE openasy_crm_config_error gauge",
    `openasy_crm_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
