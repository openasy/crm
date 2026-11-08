// Tasks, meeting links, integrations and the settings file.
import { Avatar, Button, Callout, Checkbox, EmptyState, IconButton, PageHeader, Panel, SegmentedControl, StatusBadge, useLocalePreference } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Copy, ExternalLink, Link2, Unplug } from "lucide-react";
import { useState } from "react";
import type { Booking, CalendarState, Deal, Integrations, MeetingLink, PublicSlots, Task } from "./api.ts";
import type { Ctx } from "./App.tsx";
import { Code, day, Notice, time, useLoad, when } from "./common.tsx";
import { FileSettingsPage } from "./FileSettings.tsx";
import { useT } from "./i18n.ts";

// ---------------------------------------------------------------- Tasks

export function TasksPage({ call, settings, onChanged }: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { me } = useAuth();
  const [whose, setWhose] = useState<"me" | "all">("me");
  const [state, setState] = useState<"open" | "done">("open");
  const [tasks, reload] = useLoad<{ tasks: Task[] }>(call, `/api/v1/tasks?owner=${whose}&state=${state}`);
  const [deals] = useLoad<{ deals: Deal[] }>(call, "/api/v1/deals?owner=me");
  const [error, setError] = useState<string | null>(null);
  const stale = (deals?.deals ?? []).filter((d) => d.stale);
  const toggle = (task: Task, done: boolean) =>
    void call(`/api/v1/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ done }) }).then(
      () => (reload(), onChanged()),
      (err: Error) => setError(err.message),
    );
  const dueLabel = (x: Task) =>
    x.doneAt ? t("task.done") : x.overdue ? t("task.overdueSince", { day: day(x.due, locale) }) : x.dueToday ? t("task.today") : day(x.due, locale);
  return (
    <>
      <PageHeader title={t("tasks.title")} description={t("tasks.description", { name: me.user.name, time: settings.config.tasks.remindAt })} />
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="mb-2.5 flex flex-wrap gap-2">
        <SegmentedControl
          label={t("tasks.whose")}
          value={whose}
          onChange={setWhose}
          options={[
            { value: "me", label: t("pipeline.mine") },
            { value: "all", label: t("pipeline.everyone") },
          ]}
        />
        <SegmentedControl
          label={t("tasks.state")}
          value={state}
          onChange={setState}
          options={[
            { value: "open", label: t("tasks.open") },
            { value: "done", label: t("tasks.doneTab") },
          ]}
        />
      </div>
      <div className="crm-side grid gap-2.5">
        <Panel title={state === "open" ? t("tasks.openTasks") : t("tasks.doneTasks")} aria-label={t("tasks.openTasks")}>
          {tasks === undefined ? (
            <p className="text-sm text-fg-muted">{t("loading")}</p>
          ) : !tasks?.tasks.length ? (
            <EmptyState title={t("tasks.none")} />
          ) : (
            <ul aria-label={t("nav.tasks")} className="crm-list flex flex-col gap-2">
              {tasks.tasks.map((x) => (
                <li key={x.id} className="flex items-start justify-between gap-3 border-b border-subtle pb-2 last:border-0">
                  <Checkbox
                    label={x.text}
                    description={[
                      x.deal ? (x.deal.company ? `${x.deal.company}: ${x.deal.name}` : x.deal.name) : (x.contact?.name ?? t("tasks.noDeal")),
                      whose === "all" ? (x.owner?.name ?? t("common.nobody")) : null,
                      x.time,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    checked={!!x.doneAt}
                    onChange={(e) => toggle(x, e.target.checked)}
                  />
                  <span className="flex shrink-0 items-center gap-1.5">
                    {x.deal && (
                      <a href={`/deals/${x.deal.id}`} className="text-xs">
                        {t("tasks.openDeal")}
                      </a>
                    )}
                    <StatusBadge tone={x.doneAt ? "success" : x.overdue ? "danger" : x.dueToday ? "warning" : "neutral"}>{dueLabel(x)}</StatusBadge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title={t("tasks.stale")} description={t("tasks.staleDetail")}>
          {stale.length ? (
            <ul className="crm-list flex flex-col gap-1.5 text-sm">
              {stale.map((d) => (
                <li key={d.id} className="flex flex-col">
                  <a href={`/deals/${d.id}`}>{d.company ? `${d.company.name}: ${d.name}` : d.name}</a>
                  <span className="text-2xs text-fg-muted">{t("tasks.quiet", { n: d.quietDays, stage: d.stage.name, limit: d.staleAfter ?? 0 })}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-fg-muted">{t("tasks.noStale")}</p>
          )}
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Meeting links

function LinkPanel({ call, link, stageName }: { call: Ctx["call"]; link: MeetingLink; stageName: string }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [copied, setCopied] = useState(false);
  const [slots] = useLoad<PublicSlots>(call, link.calendar ? `/api/v1/public/meetings/${link.id}` : null);
  return (
    <Panel
      aria-label={t("meetings.page")}
      title={link.url.replace(/^https?:\/\//, "")}
      actions={
        <span className="flex gap-1">
          <IconButton
            label={t("meetings.copy")}
            size="xs"
            onClick={() =>
              void navigator.clipboard?.writeText(link.url).then(
                () => setCopied(true),
                () => setCopied(true),
              )
            }
          >
            <Copy className="size-3.5" />
          </IconButton>
          <IconButton label={t("meetings.openPage")} size="xs" onClick={() => window.open(link.url, "_blank", "noopener")}>
            <ExternalLink className="size-3.5" />
          </IconButton>
        </span>
      }
    >
      <div className="flex flex-col gap-2">
        {copied && (
          <p role="status" className="m-0 text-xs text-success">
            {t("meetings.copied")}
          </p>
        )}
        <span className="text-sm font-semibold text-fg">{t("meetings.with", { name: link.name, minutes: link.minutes, owner: link.owner.name })}</span>
        <span className="text-xs text-fg-muted">
          {link.calendar ? t(`meetings.from.${link.calendar.provider}`, { zone: link.timeZone }) : t("meetings.noCalendar", { owner: link.owner.name })} ·{" "}
          {link.hours}
        </span>
        {link.calendar?.error && <Callout tone="danger" title={link.calendar.error} />}
        {slots === null && <p className="m-0 text-xs text-danger-text">{t("meetings.slotsFailed")}</p>}
        {slots && (
          <ul aria-label={t("meetings.free")} className="crm-list grid gap-1.5 sm:grid-cols-2">
            {slots.slots.slice(0, 8).map((s) => (
              <li key={s.start} className="rounded-md border border-line px-2.5 py-1.5 text-sm text-fg">
                {time(s.start, locale, slots.timeZone)}
              </li>
            ))}
            {!slots.slots.length && <li className="text-xs text-fg-muted">{t("meetings.noFree")}</li>}
          </ul>
        )}
        <span className="text-2xs text-fg-muted">
          {t("meetings.creates", { stage: stageName, buffer: link.bufferMinutes, notice: Math.round(link.noticeMinutes / 60), days: link.daysAhead })}
        </span>
      </div>
    </Panel>
  );
}

export function MeetingsPage({ call, settings }: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [links] = useLoad<{ links: MeetingLink[] }>(call, "/api/v1/meetings");
  const [cal, reloadCal] = useLoad<CalendarState>(call, "/api/v1/calendar");
  const [bookings, reloadBookings] = useLoad<{ bookings: Booking[] }>(call, "/api/v1/bookings");
  const [error, setError] = useState<string | null>(null);
  const asked = new URLSearchParams(window.location.search).get("calendar");
  const result = (["connected", "refused", "expired", "failed"] as const).find((r) => r === asked);
  const connect = (provider: "google" | "microsoft") =>
    void call<{ url: string }>("/api/v1/calendar/connect", { method: "POST", body: JSON.stringify({ provider }) }).then(
      (r) => window.location.assign(r.url),
      (err: Error) => setError(err.message),
    );
  const stageName = (id: string | null) => settings.config.pipelines.flatMap((p) => p.stages).find((s) => s.id === id)?.name ?? id ?? "";
  return (
    <>
      <PageHeader title={t("meetings.title")} description={t("meetings.description")} />
      {result && <Notice tone={result === "connected" ? "success" : "danger"}>{t(`meetings.result.${result}`)}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      <Panel title={t("meetings.calendar")} description={t("meetings.calendarDetail")} className="mb-2.5">
        {cal?.connected ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              {t(`meetings.connected.${cal.connected.provider}`, { account: cal.connected.account })}
              {cal.connected.error && <span className="block text-xs text-danger-text">{cal.connected.error}</span>}
            </span>
            <span className="flex gap-1.5">
              {cal.connected.error && (
                <Button size="sm" icon={<Link2 />} onClick={() => connect(cal.connected!.provider)}>
                  {t("meetings.reconnect")}
                </Button>
              )}
              <Button size="sm" icon={<Unplug />} onClick={() => void call("/api/v1/calendar", { method: "DELETE" }).then(reloadCal)}>
                {t("meetings.disconnect")}
              </Button>
            </span>
          </div>
        ) : cal?.available.length ? (
          <div className="flex flex-wrap gap-1.5">
            {cal.available.map((a) => (
              <Button
                key={a.provider}
                size="sm"
                icon={<Link2 />}
                disabled={!a.ready}
                onClick={() => connect(a.provider)}
                title={a.ready ? undefined : t("meetings.notReady")}
              >
                {t(`meetings.connect.${a.provider}`)}
              </Button>
            ))}
          </div>
        ) : (
          <p className="m-0 text-xs text-fg-muted">{t("meetings.noProviders")}</p>
        )}
      </Panel>
      <div className="crm-halves grid gap-2.5">
        <div className="flex min-w-0 flex-col gap-2.5">
          {links?.links.length ? (
            links.links.map((l) => <LinkPanel key={l.id} call={call} link={l} stageName={stageName(l.stage)} />)
          ) : (
            <EmptyState title={t("meetings.noLinks")}>{t("meetings.noLinksDetail")}</EmptyState>
          )}
        </div>
        <Panel title={t("meetings.booked")} flush>
          {bookings?.bookings.length ? (
            <ul aria-label={t("meetings.bookings")} className="crm-list flex flex-col">
              {bookings.bookings.map((b) => (
                <li key={b.id} className="flex items-center gap-2 border-b border-subtle px-3 py-2 last:border-0">
                  <Avatar name={b.name} size="sm" />
                  <span className="flex min-w-0 grow flex-col">
                    <span className="truncate text-sm text-fg">
                      {b.deal ? (
                        <a href={`/deals/${b.deal}`}>{b.company ? `${b.name}, ${b.company}` : b.name}</a>
                      ) : b.company ? (
                        `${b.name}, ${b.company}`
                      ) : (
                        b.name
                      )}
                    </span>
                    <span className="text-2xs text-fg-muted">
                      {b.state === "confirmed" && b.made
                        ? t(`meetings.made.${b.made.what}`, { stage: stageName(b.made.stage) })
                        : t(`meetings.state.${b.state}`)}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-fg-muted">{when(b.start, locale)}</span>
                  {b.state === "confirmed" && can("editor") && (
                    <Button
                      size="xs"
                      onClick={() =>
                        void call(`/api/v1/bookings/${b.id}/cancel`, { method: "POST" }).then(reloadBookings, (err: Error) => setError(err.message))
                      }
                    >
                      {t("common.cancel")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-3 text-sm text-fg-muted">{t("meetings.noBookings")}</p>
          )}
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Integrations

function LinkBadge({ s, t }: { s: { linked?: boolean; configured?: boolean; okAt: string | null; error: string | null }; t: ReturnType<typeof useT> }) {
  const on = s.linked ?? s.configured;
  return (
    <StatusBadge tone={!on ? "neutral" : s.error ? "danger" : s.okAt ? "success" : "neutral"}>
      {!on ? t("integrations.notLinked") : s.error ? t("integrations.failing") : s.okAt ? t("integrations.ok") : t("integrations.notYet")}
    </StatusBadge>
  );
}

export function IntegrationsPage({ call, settings }: Ctx) {
  const t = useT();
  const [i] = useLoad<Integrations>(call, "/api/v1/integrations");
  const origin = window.location.origin;
  const c = settings.config;
  return (
    <>
      <PageHeader title={t("integrations.title")} description={t("integrations.description")} />
      <div className="crm-halves grid gap-2.5">
        <Panel title={t("integrations.audience")} description={t("integrations.audienceDetail")} actions={i && <LinkBadge s={i.audience} t={t} />}>
          {i?.audience.linked ? (
            <p className="m-0 text-xs text-fg-muted">
              {t("integrations.audienceOn", { url: i.audience.url ?? "", queued: i.audience.queued })}
              {!i.audience.tokenSet && ` ${t("integrations.tokenUnset", { name: c.audience?.token ?? "" })}`}
              {i.audience.error && <span className="block text-danger-text">{i.audience.error}</span>}
            </p>
          ) : (
            <Code label={t("integrations.audience")}>{`audience: { url: http://audience:8080, token: CRM_AUDIENCE_TOKEN }`}</Code>
          )}
          <p className="mt-2 mb-0 text-xs text-fg-muted">{t("integrations.erasure")}</p>
        </Panel>
        <Panel title={t("integrations.messages")} description={t("integrations.messagesDetail")} actions={i && <LinkBadge s={i.messages} t={t} />}>
          {i?.messages.linked ? (
            <ul className="crm-list flex flex-col gap-1 text-xs">
              {i.messages.sequences.map((s) => (
                <li key={s.id}>
                  {s.name} · <span className="font-mono">{s.event}</span>
                </li>
              ))}
              {i.messages.error && <li className="text-danger-text">{i.messages.error}</li>}
            </ul>
          ) : (
            <Code label={t("integrations.messages")}>{`messages:
  url: http://messages:8080
  token: CRM_MESSAGES_TOKEN
  sequences:
    follow-up: { name: Demo follow-up, event: crm_demo_follow_up }`}</Code>
          )}
        </Panel>
        <Panel title={t("integrations.helpdesk")} description={t("integrations.helpdeskDetail")}>
          <Code label={t("integrations.helpdesk")}>{`GET ${origin}/api/v1/lookup?email=gizem@avci.example
Authorization: Bearer <a CRM token with the viewer role>

200 { "contact": { "id", "name", "email", "title", "company", "plan", "owner", "url" }, "deals": [...] }
404 when no contact has exactly that address`}</Code>
        </Panel>
        <Panel title={t("integrations.liveChat")} description={t("integrations.liveChatDetail")}>
          <Code label={t("integrations.liveChat")}>{`POST ${origin}/api/v1/leads
Authorization: Bearer <a CRM token with the editor role>

{ "external_id": "live-chat-7c1e", "source": "live-chat", "name": "Nihan Er",
  "email": "nihan@example.com", "title": "Do you have a plan for 5 users?", ... }

201 { "lead": { "id", "url" } }, 200 for the same external_id again`}</Code>
          <p className="mt-2 mb-0 text-xs text-fg-muted">{t("integrations.leadsGo", { stage: c.leads.stage, owner: c.leads.owner ?? t("common.nobody") })}</p>
        </Panel>
        <Panel title={t("integrations.mail")} description={t("integrations.mailDetail")} actions={i && <LinkBadge s={i.mail} t={t} />}>
          <p className="m-0 text-xs text-fg-muted">{i?.mail.configured ? t("integrations.mailOn", { host: i.mail.host ?? "" }) : t("integrations.mailOff")}</p>
          {i?.mail.error && <p className="m-0 text-xs text-danger-text">{i.mail.error}</p>}
        </Panel>
        <Panel title={t("integrations.api")} description={t("integrations.apiDetail")}>
          <Code label={t("integrations.api")}>{`curl -X POST ${origin}/api/v1/deals \\
  -H "Authorization: Bearer $CRM_TOKEN" -H "content-type: application/json" \\
  -d '{"name":"12 users","companyName":"Tekin Yapı","value":108000,"stage":"demo"}'`}</Code>
          <a href="/api/docs/" className="mt-2 inline-block text-xs">
            {t("integrations.reference")}
          </a>
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Settings

export function SettingsFilePage({ settings }: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const c = settings.config;
  const f = settings.file;
  const applied = f?.appliedAt ? when(f.appliedAt, locale) : t("settings.notYet");
  return (
    <FileSettingsPage
      file="crm.yaml"
      applied={applied}
      yaml={settings.yaml || t("settings.noFile")}
      problems={
        <>
          {f?.error && (
            <Callout tone="danger" title={t("file.notApplied")} className="mb-2.5">
              {f.error}
            </Callout>
          )}
          {!!f?.warnings.length && (
            <Callout tone="warning" title={t("settings.warnings")} className="mb-2.5">
              <ul className="crm-list">
                {f.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Callout>
          )}
        </>
      }
      groups={[
        ...c.pipelines.map((p) => ({
          title: t("settings.pipeline", { name: p.name }),
          description: t("settings.pipelineDetail"),
          items: [
            ...p.stages.map((s) => ({
              label: s.name,
              value: s.staleDays === null ? t("settings.stageNever", { p: s.probability }) : t("settings.stage", { p: s.probability, days: s.staleDays }),
              path: `pipelines.${p.id}.stages.${s.id}`,
            })),
            { label: t("settings.lostReasons"), value: p.lostReasons.join(", ") || t("settings.anyReason"), path: `pipelines.${p.id}.lost_reasons` },
          ],
        })),
        {
          title: t("settings.quotesMeetings"),
          items: [
            { label: t("settings.currencyVat"), value: t("settings.currencyVatValue", { currency: c.currency, vat: c.quotes.vat }), path: "quotes.vat" },
            {
              label: t("settings.quoteSeller"),
              value: `${c.quotes.seller.name}, ${t("settings.validFor", { days: c.quotes.validDays })}`,
              path: "quotes.seller",
            },
            { label: t("settings.plans"), value: c.plans.map((p) => p.name).join(", ") || t("settings.none"), path: "plans" },
            {
              label: t("settings.leads"),
              value: t("settings.leadsValue", { stage: c.leads.stage, owner: c.leads.owner ?? t("common.nobody") }),
              path: "leads",
            },
            { label: t("settings.reminders"), value: t("settings.remindersValue", { time: c.tasks.remindAt, zone: c.timeZone }), path: "tasks.remind_at" },
            { label: t("settings.mail"), value: c.mail ? `${c.mail.host}:${c.mail.port}, ${c.mail.from}` : t("settings.none"), path: "mail" },
          ],
        },
        {
          title: t("settings.roles"),
          items: [{ label: t("settings.rolesLabel"), value: t("settings.rolesValue"), path: "Members" }],
        },
        {
          title: t("settings.links"),
          items: [
            { label: "Audience", value: c.audience?.url ?? t("settings.notLinked"), path: "audience" },
            {
              label: "Messages",
              value: c.messages ? `${c.messages.url}, ${t("settings.sequences", { n: c.messages.sequences.length })}` : t("settings.notLinked"),
              path: "messages",
            },
          ],
        },
      ]}
    />
  );
}
