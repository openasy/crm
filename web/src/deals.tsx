// The pipeline board and one deal: its stages, value and forecast, the quote, activities, tasks and the lead's profile.
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  cn,
  Dialog,
  IconButton,
  KpiCard,
  KpiGrid,
  PageHeader,
  Panel,
  SearchInput,
  SegmentedControl,
  SelectField,
  StatusBadge,
  TextField,
  useLocalePreference,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { ArrowLeft, CalendarCheck, FileDown, Mail, Phone, Plus, RotateCcw, Send, StickyNote, ThumbsDown, Trash2, Trophy, Workflow, Zap } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Activity, AudienceProfile, Deal, DealDetail, Quote, Report } from "./api.ts";
import type { Ctx } from "./App.tsx";
import { day, money, Notice, sourceLabel, today, useLoad, when } from "./common.tsx";
import { useT, type T } from "./i18n.ts";

// ---------------------------------------------------------------- New deal

export function NewDealDialog({
  call,
  settings,
  members,
  open,
  onOpenChange,
  onCreated,
  company,
}: Ctx & { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (d: Deal) => void; company?: string }) {
  const t = useT();
  const { me } = useAuth();
  const c = settings.config;
  const [pipeline, setPipeline] = useState(c.pipelines[0]!.id);
  const p = c.pipelines.find((x) => x.id === pipeline)!;
  const [f, setF] = useState({ name: "", companyName: company ?? "", value: "", stage: p.stages[0]!.id, expectedClose: "", owner: me.user.id });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const d = await call<Deal>("/api/v1/deals", {
        method: "POST",
        body: JSON.stringify({
          name: f.name,
          pipeline,
          stage: f.stage,
          value: f.value ? Number(f.value.replace(",", ".")) : 0,
          ...(f.companyName.trim() && { companyName: f.companyName.trim() }),
          ...(f.expectedClose && { expectedClose: f.expectedClose }),
          owner: f.owner || null,
        }),
      });
      onCreated(d);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("deal.new")}
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!f.name.trim()}>
            {t("deal.create")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        {error && <Notice tone="danger">{error}</Notice>}
        <TextField label={t("deal.name")} value={f.name} onChange={set("name")} placeholder={t("deal.namePlaceholder")} required />
        <TextField label={t("deal.company")} value={f.companyName} onChange={set("companyName")} hint={t("deal.companyHint")} />
        <TextField
          label={t("deal.value", { currency: c.currency === "TRY" ? "TL" : c.currency })}
          value={f.value}
          onChange={set("value")}
          inputMode="decimal"
          hint={t("deal.valueHint")}
        />
        {c.pipelines.length > 1 && (
          <SelectField
            label={t("deal.pipeline")}
            value={pipeline}
            onChange={(e) => {
              setPipeline(e.target.value);
              setF((x) => ({ ...x, stage: c.pipelines.find((y) => y.id === e.target.value)!.stages[0]!.id }));
            }}
            options={c.pipelines.map((x) => ({ value: x.id, label: x.name }))}
          />
        )}
        <SelectField
          label={t("deal.stage")}
          value={f.stage}
          onChange={set("stage")}
          options={p.stages.map((s) => ({ value: s.id, label: `${s.name}, ${s.probability}%` }))}
        />
        <TextField label={t("deal.expectedClose")} type="date" value={f.expectedClose} onChange={set("expectedClose")} />
        <SelectField
          label={t("common.owner")}
          value={f.owner}
          onChange={set("owner")}
          options={[{ value: "", label: t("common.nobody") }, ...members.map((m) => ({ value: m.id, label: m.name }))]}
        />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Pipeline

function DealCard({ d, t, locale }: { d: Deal; t: T; locale: string }) {
  return (
    <li>
      <a href={`/deals/${d.id}`} className="crm-card flex w-full flex-col gap-1 rounded-md border border-line bg-surface p-2.5 text-start no-underline">
        <span className="truncate text-sm font-medium text-fg">{d.company?.name ?? d.name}</span>
        {d.company && <span className="truncate text-xs text-fg-muted">{d.name}</span>}
        <span className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs font-semibold text-fg tabular-nums">{money(d.value, d.currency, locale)}</span>
          {d.owner ? <Avatar name={d.owner.name} size="sm" className="size-5" /> : <span className="text-2xs text-fg-muted">{t("common.nobody")}</span>}
        </span>
        <span className="flex flex-wrap items-center gap-1 text-2xs text-fg-muted">
          {d.expectedClose ? t("deal.closeOn", { day: day(d.expectedClose, locale) }) : t("deal.noClose")}
          {d.overdue && <Badge tone="warning">{t("deal.overdue")}</Badge>}
          {d.stale && <Badge tone="warning">{t("deal.staleQuiet", { n: d.quietDays })}</Badge>}
        </span>
      </a>
    </li>
  );
}

export function PipelinePage(ctx: Ctx) {
  const { call, settings } = ctx;
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const c = settings.config;
  const [pipeline, setPipeline] = useState(c.pipelines[0]!.id);
  const [who, setWho] = useState<"all" | "mine">("all");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [deals] = useLoad<{ deals: Deal[] }>(call, `/api/v1/deals?pipeline=${encodeURIComponent(pipeline)}${who === "mine" ? "&owner=me" : ""}`);
  const [report] = useLoad<Report>(call, `/api/v1/report?pipeline=${encodeURIComponent(pipeline)}`);
  const p = c.pipelines.find((x) => x.id === pipeline)!;
  const words = query.toLocaleLowerCase(locale);
  const shown = (deals?.deals ?? []).filter((d) => `${d.company?.name ?? ""} ${d.name} ${d.contact?.name ?? ""}`.toLocaleLowerCase(locale).includes(words));
  const outside = shown.filter((d) => !d.stage.inFile);
  return (
    <>
      <PageHeader
        title={t("pipeline.title")}
        description={t("pipeline.description")}
        actions={
          can("editor") && (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              {t("deal.new")}
            </Button>
          )
        }
      />
      <div className="mb-2.5 flex flex-wrap items-end gap-2">
        {c.pipelines.length > 1 && (
          <SelectField
            label={t("deal.pipeline")}
            value={pipeline}
            onChange={(e) => setPipeline(e.target.value)}
            options={c.pipelines.map((x) => ({ value: x.id, label: x.name }))}
          />
        )}
        <SegmentedControl
          label={t("pipeline.whose")}
          value={who}
          onChange={setWho}
          options={[
            { value: "all", label: t("pipeline.everyone") },
            { value: "mine", label: t("pipeline.mine") },
          ]}
        />
        <SearchInput
          label={t("pipeline.search")}
          placeholder={t("pipeline.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="crm-search"
        />
      </div>
      <div className="crm-board grid gap-2.5" style={{ ["--crm-stages" as string]: String(Math.min(p.stages.length, 6)) }}>
        {p.stages.map((s) => {
          const inStage = shown.filter((d) => d.stage.id === s.id);
          return (
            <section key={s.id} aria-label={s.name} className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-line bg-canvas p-2">
              <header className="flex items-baseline justify-between gap-2 px-1">
                <h2 className="text-sm font-semibold text-fg">
                  {s.name} <span className="text-2xs font-normal text-fg-muted">{s.probability}%</span>
                </h2>
                <span className="font-mono text-2xs text-fg-muted tabular-nums">
                  {money(
                    inStage.reduce((n, d) => n + d.value, 0),
                    c.currency,
                    locale,
                  )}
                </span>
              </header>
              <ul className="crm-list flex flex-col gap-1.5">
                {inStage.map((d) => (
                  <DealCard key={d.id} d={d} t={t} locale={locale} />
                ))}
                {!inStage.length && <li className="px-1 py-2 text-xs text-fg-muted">{deals === undefined ? t("loading") : t("pipeline.noDeals")}</li>}
              </ul>
            </section>
          );
        })}
      </div>
      {outside.length > 0 && (
        <Panel title={t("pipeline.outside")} description={t("pipeline.outsideDetail")} className="mt-2.5">
          <ul className="crm-list flex flex-col gap-1 text-sm">
            {outside.map((d) => (
              <li key={d.id}>
                <a href={`/deals/${d.id}`}>{d.company ? `${d.company.name}: ${d.name}` : d.name}</a> · {d.stage.name}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {report && (
        <p className="mt-2.5 text-xs text-fg-muted">
          {t("pipeline.thisMonth", {
            won: money(report.won.value, c.currency, locale),
            lost: money(report.lost.value, c.currency, locale),
            wonCount: report.won.count,
            lostCount: report.lost.count,
          })}
          {report.lost.deals[0]?.reason &&
            ` ${t("pipeline.lastLost", { company: report.lost.deals[0].company ?? report.lost.deals[0].name, reason: report.lost.deals[0].reason })}`}
        </p>
      )}
      {creating && <NewDealDialog {...ctx} open={creating} onOpenChange={setCreating} onCreated={(d) => (window.location.href = `/deals/${d.id}`)} />}
    </>
  );
}

// ---------------------------------------------------------------- One deal

const KIND_ICON = { call: Phone, email: Mail, meeting: CalendarCheck, note: StickyNote, system: Zap } as const;

export function ActivityList({ activities, t, locale }: { activities: Activity[]; t: T; locale: string }) {
  if (!activities.length) return <p className="text-sm text-fg-muted">{t("activity.none")}</p>;
  return (
    <ol aria-label={t("activity.list")} className="crm-list flex flex-col gap-2">
      {activities.map((a) => {
        const Icon = KIND_ICON[a.kind];
        return (
          <li key={a.id} className="flex gap-2 text-sm">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-subtle text-fg-muted">
              <Icon aria-hidden className="size-3.5" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="crm-pre text-fg">{a.text}</span>
              <span className="text-2xs text-fg-muted">
                {a.by.name} · {when(a.at, locale)}
                {a.kind !== "system" && ` · ${t(`activity.kind.${a.kind}`)}`}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function LogActivityDialog({
  call,
  open,
  onOpenChange,
  target,
  onDone,
}: {
  call: Ctx["call"];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  target: Record<string, string>;
  onDone: () => void;
}) {
  const t = useT();
  const [kind, setKind] = useState<"call" | "meeting" | "email" | "note">("call");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("activity.log")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        void call("/api/v1/activities", { method: "POST", body: JSON.stringify({ kind, text: text.trim(), ...target }) }).then(
          () => {
            setText("");
            onDone();
          },
          (err: Error) => setError(err.message),
        );
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!text.trim()}>
            {t(`activity.save.${kind}`)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        {error && <Notice tone="danger">{error}</Notice>}
        <SegmentedControl
          label={t("activity.kindLabel")}
          value={kind}
          onChange={setKind}
          options={(["call", "meeting", "email", "note"] as const).map((k) => ({ value: k, label: t(`activity.kind.${k}`) }))}
        />
        <TextField label={t("activity.what")} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("activity.placeholder")} />
      </div>
    </Dialog>
  );
}

export function AddTaskDialog({
  call,
  open,
  onOpenChange,
  target,
  onDone,
}: {
  call: Ctx["call"];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  target: Record<string, string>;
  onDone: () => void;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const [due, setDue] = useState(today(1));
  const [time, setTime] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("task.add")}
      onSubmit={(e) => {
        e.preventDefault();
        void call("/api/v1/tasks", { method: "POST", body: JSON.stringify({ text, due, ...(time && { time }), ...target }) }).then(
          () => {
            setText("");
            onDone();
          },
          (err: Error) => setError(err.message),
        );
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!text.trim() || !due}>
            {t("task.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        {error && <Notice tone="danger">{error}</Notice>}
        <TextField label={t("task.text")} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("task.placeholder")} />
        <TextField label={t("task.due")} type="date" value={due} onChange={(e) => setDue(e.target.value)} hint={t("task.dueHint")} />
        <TextField label={t("task.time")} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      </div>
    </Dialog>
  );
}

type EditLine = { item: string; quantity: string; unitPrice: string; discount: string };

function QuoteDialog({
  call,
  deal,
  quote,
  open,
  onOpenChange,
  onDone,
  vat,
}: {
  call: Ctx["call"];
  deal: DealDetail;
  quote: Quote | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
  vat: number;
}) {
  const t = useT();
  const [locale] = useLocalePreference();
  const start: EditLine[] = (
    quote?.lines ??
    deal.quotes[0]?.lines ?? [{ item: deal.name, quantity: 1, unitPrice: deal.value, discount: 0, total: deal.value }]
  ).map((l) => ({
    item: l.item,
    quantity: String(l.quantity),
    unitPrice: String(l.unitPrice),
    discount: String(l.discount || ""),
  }));
  const [lines, setLines] = useState(start);
  const [notes, setNotes] = useState(quote?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const n = (s: string) => Number(s.replace(",", ".")) || 0;
  const subtotal = lines.reduce((s, l) => s + Math.round(n(l.quantity) * n(l.unitPrice) * (1 - n(l.discount) / 100) * 100) / 100, 0);
  const setLine = (i: number, k: keyof EditLine, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const save = () => {
    const body = JSON.stringify({
      lines: lines.map((l) => ({ item: l.item, quantity: n(l.quantity), unitPrice: n(l.unitPrice), discount: n(l.discount) })),
      notes: notes || null,
    });
    void call(quote ? `/api/v1/quotes/${quote.id}` : `/api/v1/deals/${deal.id}/quotes`, { method: quote ? "PATCH" : "POST", body }).then(onDone, (err: Error) =>
      setError(err.message),
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={quote ? t("quote.edit", { number: quote.number }) : t("quote.new")}
      description={t("quote.dialogDetail", { vat })}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!lines.length || lines.some((l) => !l.item.trim())}>
            {t("quote.saveDraft")}
          </Button>
        </>
      }
    >
      {error && <Notice tone="danger">{error}</Notice>}
      <table className="crm-lines w-full text-start text-sm">
        <caption className="sr-only">{t("quote.lines")}</caption>
        <thead className="text-xs text-fg-muted">
          <tr>
            <th className="py-1 pe-2 font-semibold">{t("quote.item")}</th>
            <th className="w-16 py-1 pe-2 font-semibold">{t("quote.qty")}</th>
            <th className="w-28 py-1 pe-2 font-semibold">{t("quote.price")}</th>
            <th className="w-16 py-1 pe-2 font-semibold">{t("quote.discount")}</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className="py-1 pe-2">
                <TextField label={t("quote.itemN", { n: i + 1 })} className="sr-label" value={l.item} onChange={(e) => setLine(i, "item", e.target.value)} />
              </td>
              <td className="py-1 pe-2">
                <TextField
                  label={t("quote.qtyN", { n: i + 1 })}
                  value={l.quantity}
                  inputMode="decimal"
                  onChange={(e) => setLine(i, "quantity", e.target.value)}
                />
              </td>
              <td className="py-1 pe-2">
                <TextField
                  label={t("quote.priceN", { n: i + 1 })}
                  value={l.unitPrice}
                  inputMode="decimal"
                  onChange={(e) => setLine(i, "unitPrice", e.target.value)}
                />
              </td>
              <td className="py-1 pe-2">
                <TextField
                  label={t("quote.discountN", { n: i + 1 })}
                  value={l.discount}
                  inputMode="decimal"
                  placeholder="0"
                  onChange={(e) => setLine(i, "discount", e.target.value)}
                />
              </td>
              <td className="py-1 align-bottom">
                <IconButton label={t("quote.removeLine", { n: i + 1 })} size="xs" type="button" onClick={() => setLines((ls) => ls.filter((_x, j) => j !== i))}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex items-center justify-between gap-2">
        <Button type="button" size="sm" icon={<Plus />} onClick={() => setLines((ls) => [...ls, { item: "", quantity: "1", unitPrice: "0", discount: "" }])}>
          {t("quote.addLine")}
        </Button>
        <span className="text-sm font-semibold">{t("quote.subtotalIs", { amount: money(subtotal, deal.currency, locale) })}</span>
      </div>
      <label className="mt-2.5 flex flex-col gap-1 text-xs text-fg-muted">
        {t("quote.notes")}
        <textarea className="crm-textarea" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
      </label>
    </Dialog>
  );
}

function QuotePanel({
  call,
  deal,
  reload,
  canEdit,
  mail,
  vat,
}: {
  call: Ctx["call"];
  deal: DealDetail;
  reload: () => void;
  canEdit: boolean;
  mail: boolean;
  vat: number;
}) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [editing, setEditing] = useState<Quote | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = deal.quotes[0];
  const act = (path: string, body?: unknown) => {
    setError(null);
    void call(path, { method: "POST", ...(body !== undefined && { body: JSON.stringify(body) }) }).then(reload, (err: Error) => setError(err.message));
  };
  const tl = (n: number) => money(n, deal.currency, locale);
  return (
    <Panel
      aria-label={t("quote.title")}
      title={q ? t("quote.titleN", { number: q.number }) : t("quote.title")}
      description={q ? t(`quote.state.${q.state}`, { day: q.sentAt ? day(q.sentAt.slice(0, 10), locale) : "" }) : t("quote.none")}
      actions={
        <span className="flex flex-wrap gap-1.5">
          {q && (
            <a href={q.pdf} download className="no-underline">
              <Button size="sm" icon={<FileDown />} type="button">
                {t("quote.pdf")}
              </Button>
            </a>
          )}
          {canEdit && (!q || q.state !== "draft") && deal.status === "open" && (
            <Button size="sm" icon={<Plus />} onClick={() => setEditing("new")}>
              {t("quote.new")}
            </Button>
          )}
        </span>
      }
      flush
    >
      {error && (
        <div className="px-3 pt-2">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}
      {q && (
        <>
          <table className="w-full text-start text-sm">
            <caption className="sr-only">{t("quote.lines")}</caption>
            <thead className="bg-canvas text-xs text-fg-muted">
              <tr>
                <th className="px-3 py-1.5 font-semibold">{t("quote.item")}</th>
                <th className="px-3 py-1.5 text-end font-semibold">{t("quote.qty")}</th>
                <th className="px-3 py-1.5 text-end font-semibold">{t("quote.price")}</th>
                <th className="px-3 py-1.5 text-end font-semibold">{t("quote.total")}</th>
              </tr>
            </thead>
            <tbody>
              {q.lines.map((l, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="px-3 py-1.5">
                    {l.item}
                    {l.discount > 0 && <span className="text-2xs text-fg-muted"> · {t("quote.less", { n: l.discount })}</span>}
                  </td>
                  <td className="px-3 py-1.5 text-end font-mono text-xs">{l.quantity}</td>
                  <td className="px-3 py-1.5 text-end font-mono text-xs">{tl(l.unitPrice)}</td>
                  <td className="px-3 py-1.5 text-end font-mono text-xs">{tl(l.total)}</td>
                </tr>
              ))}
              <tr className="border-t border-line font-semibold">
                <td className="px-3 py-1.5" colSpan={3}>
                  {t("quote.subtotal")}
                </td>
                <td className="px-3 py-1.5 text-end font-mono text-xs">{tl(q.subtotal)}</td>
              </tr>
              <tr className="border-t border-line text-fg-muted">
                <td className="px-3 py-1.5" colSpan={3}>
                  {t("quote.vat", { n: q.vat })}
                </td>
                <td className="px-3 py-1.5 text-end font-mono text-xs">{tl(q.vatAmount)}</td>
              </tr>
              <tr className="border-t border-line">
                <td className="px-3 py-1.5" colSpan={3}>
                  {t("quote.withVat")}
                </td>
                <td className="px-3 py-1.5 text-end font-mono text-xs">{tl(q.total)}</td>
              </tr>
            </tbody>
          </table>
          {canEdit && (
            <div className="flex flex-wrap gap-1.5 border-t border-line px-3 py-2">
              {q.state === "draft" && (
                <>
                  <Button size="sm" onClick={() => setEditing(q)}>
                    {t("quote.editLines")}
                  </Button>
                  {mail && deal.contact?.email && (
                    <Button size="sm" variant="primary" icon={<Send />} onClick={() => act(`/api/v1/quotes/${q.id}/send`, { email: true })}>
                      {t("quote.email", { to: deal.contact.email })}
                    </Button>
                  )}
                  <Button size="sm" onClick={() => act(`/api/v1/quotes/${q.id}/send`, { email: false })}>
                    {t("quote.markSent")}
                  </Button>
                </>
              )}
              {q.state === "sent" && (
                <>
                  <Button size="sm" variant="primary" icon={<Trophy />} onClick={() => act(`/api/v1/quotes/${q.id}/accept`)}>
                    {t("quote.accept")}
                  </Button>
                  <Button size="sm" onClick={() => act(`/api/v1/quotes/${q.id}/decline`)}>
                    {t("quote.decline")}
                  </Button>
                </>
              )}
            </div>
          )}
        </>
      )}
      {editing && (
        <QuoteDialog
          call={call}
          deal={deal}
          quote={editing === "new" ? null : editing}
          open
          onOpenChange={(o) => !o && setEditing(null)}
          vat={vat}
          onDone={() => (setEditing(null), reload())}
        />
      )}
    </Panel>
  );
}

function AudiencePanel({ call, dealId }: { call: Ctx["call"]; dealId: string }) {
  const t = useT();
  const [locale] = useLocalePreference();
  const [a] = useLoad<AudienceProfile>(call, `/api/v1/deals/${dealId}/audience`);
  if (a && !a.linked) return null;
  return (
    <Panel title={t("audience.title")} description={t("audience.from")}>
      {a === undefined ? (
        <p className="text-xs text-fg-muted">{t("loading")}</p>
      ) : a === null ? (
        <p className="text-xs text-danger-text">{t("audience.failed")}</p>
      ) : !a.found || !a.profile ? (
        <p className="text-xs text-fg-muted">{t("audience.notFound")}</p>
      ) : (
        <>
          <ul aria-label={t("audience.title")} className="crm-list flex flex-col gap-1 text-xs">
            {a.profile.pages.map((p) => (
              <li key={p.path} className="text-fg">
                {t("audience.read", { path: p.path, count: p.views })}
              </li>
            ))}
            {a.profile.recent.map((e, i) => (
              <li key={i} className="text-fg">
                {e.text ?? e.type} <span className="text-fg-muted">· {when(e.at, locale)}</span>
              </li>
            ))}
            {!a.profile.pages.length && !a.profile.recent.length && <li className="text-fg-muted">{t("audience.nothing")}</li>}
          </ul>
          {a.url && (
            <a href={a.url} className="mt-1.5 inline-block text-xs" target="_blank" rel="noreferrer">
              {t("audience.open")}
            </a>
          )}
        </>
      )}
    </Panel>
  );
}

export function DealPage(ctx: Ctx & { id: string }) {
  const { call, settings, members, id } = ctx;
  const t = useT();
  const [locale] = useLocalePreference();
  const [deal, reload] = useLoad<DealDetail>(call, `/api/v1/deals/${id}`);
  const [notice, setNotice] = useState<{ text: string; tone?: "danger" } | null>(null);
  const [dialog, setDialog] = useState<"log" | "task" | "lost" | "won" | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const c = settings.config;
  if (deal === undefined) return <PageHeader title={t("loading")} />;
  if (deal === null) return <PageHeader title={t("deal.notFound")} breadcrumbs={[{ label: t("nav.pipeline"), href: "/pipeline" }]} />;
  const p = c.pipelines.find((x) => x.id === deal.pipeline);
  const stages = p?.stages ?? [];
  const tl = (n: number) => money(n, deal.currency, locale);
  const fail = (err: Error) => setNotice({ text: err.message, tone: "danger" });
  const post = (path: string, body: unknown, done?: (d: DealDetail) => void) =>
    void call<DealDetail>(path, { method: "POST", body: JSON.stringify(body) }).then((d) => {
      done?.(d);
      reload();
      ctx.onChanged();
    }, fail);
  const move = (stage: string) => post(`/api/v1/deals/${id}/move`, { stage });
  const nextTask = deal.tasks.find((x) => !x.doneAt);
  const title = deal.company ? `${deal.company.name}: ${deal.name}` : deal.name;
  const target = { deal: id };
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t("nav.pipeline"), href: "/pipeline" }, { label: deal.company?.name ?? deal.name }]}
        title={title}
        meta={
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusBadge tone={deal.status === "won" ? "success" : deal.status === "lost" ? "danger" : "info"}>
              {deal.status === "open" ? deal.stage.name : t(`status.${deal.status}`)}
            </StatusBadge>
            {deal.stale && <Badge tone="warning">{t("deal.staleQuiet", { n: deal.quietDays })}</Badge>}
          </span>
        }
        actions={
          <>
            <a href="/pipeline" className="no-underline">
              <Button icon={<ArrowLeft />} type="button">
                {t("deal.back")}
              </Button>
            </a>
            {deal.canEdit && deal.status === "open" && (
              <>
                <Button icon={<ThumbsDown />} onClick={() => (setReason(deal.lostReasons[0] ?? ""), setDialog("lost"))}>
                  {t("deal.markLost")}
                </Button>
                <Button
                  variant="primary"
                  icon={<Trophy />}
                  onClick={() =>
                    deal.wonReasons.length
                      ? (setReason(""), setDialog("won"))
                      : post(`/api/v1/deals/${id}/won`, {}, (d) => setNotice({ text: t("deal.wonNotice", { value: tl(d.value) }) }))
                  }
                >
                  {t("deal.markWon")}
                </Button>
              </>
            )}
            {deal.canEdit && deal.status !== "open" && (
              <Button icon={<RotateCcw />} onClick={() => post(`/api/v1/deals/${id}/reopen`, {})}>
                {t("deal.reopen")}
              </Button>
            )}
          </>
        }
      />
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {!deal.canEdit && <p className="mb-2.5 text-xs text-fg-muted">{t("deal.readOnly", { owner: deal.owner?.name ?? t("common.nobody") })}</p>}
      <ol aria-label={t("deal.stages")} className="crm-list mb-2.5 flex overflow-hidden rounded-md border border-line">
        {stages.map((x, i) => {
          const reached = deal.status === "won" || stages.findIndex((y) => y.id === deal.stage.id) >= i;
          const current = deal.status === "open" && x.id === deal.stage.id;
          return (
            <li
              key={x.id}
              aria-current={current ? "step" : undefined}
              className={cn("flex grow border-e border-line text-xs last:border-e-0", reached ? "bg-accent-soft text-accent-text" : "bg-surface text-fg-muted")}
            >
              <button
                type="button"
                disabled={!deal.canEdit || deal.status !== "open" || current}
                onClick={() => move(x.id)}
                className="flex w-full flex-col px-3 py-1.5 text-start disabled:cursor-default"
                title={deal.canEdit && deal.status === "open" && !current ? t("deal.moveTo", { stage: x.name }) : undefined}
              >
                <span className="font-medium">{x.name}</span>
                <span className="text-2xs">{x.probability}%</span>
              </button>
            </li>
          );
        })}
        <li
          aria-current={deal.status !== "open" ? "step" : undefined}
          className={cn(
            "flex grow flex-col px-3 py-1.5 text-xs",
            deal.status === "won" ? "bg-success-soft text-fg" : deal.status === "lost" ? "bg-danger-soft text-fg" : "bg-surface text-fg-muted",
          )}
        >
          <span className="font-medium">{deal.status === "lost" ? t("status.lost") : t("status.won")}</span>
          <span className="text-2xs">{deal.status === "lost" ? "0%" : "100%"}</span>
        </li>
      </ol>
      <div className="crm-side grid gap-2.5">
        <div className="flex min-w-0 flex-col gap-2.5">
          <KpiGrid minWidth={150}>
            <KpiCard label={t("deal.valueLabel")} value={tl(deal.value)} unit={t("deal.withoutVat")} />
            <KpiCard label={t("deal.weighted")} value={tl(deal.weighted)} unit={t("deal.at", { n: deal.stage.probability })} />
            <KpiCard
              label={deal.status === "open" ? t("deal.expectedClose") : t("deal.closed")}
              value={
                deal.status === "open"
                  ? deal.expectedClose
                    ? day(deal.expectedClose, locale)
                    : "–"
                  : deal.closedAt
                    ? day(deal.closedAt.slice(0, 10), locale)
                    : "–"
              }
              delta={deal.overdue ? { label: t("deal.overdue"), intent: "bad" } : deal.reason ? { label: deal.reason, intent: "neutral" } : undefined}
            />
          </KpiGrid>
          {deal.canEdit && deal.status === "open" && <DealFields call={call} deal={deal} members={members} onSaved={reload} />}
          <QuotePanel call={call} deal={deal} reload={reload} canEdit={deal.canEdit} mail={!!c.mail} vat={c.quotes.vat} />
          <Panel
            aria-label={t("activity.title")}
            title={t("activity.title")}
            actions={
              deal.canEdit && (
                <Button size="sm" icon={<Plus />} onClick={() => setDialog("log")}>
                  {t("activity.log")}
                </Button>
              )
            }
          >
            <ActivityList activities={deal.activities} t={t} locale={locale} />
          </Panel>
        </div>
        <div className="flex flex-col gap-2.5">
          <Panel title={t("deal.contact")} aria-label={t("deal.contact")}>
            {deal.contactDetail ? (
              <div className="flex flex-col gap-2 text-xs">
                <a href={`/contacts/${deal.contactDetail.id}`} className="flex items-center gap-2 no-underline">
                  <Avatar name={deal.contactDetail.name} size="sm" />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium text-fg">{deal.contactDetail.name}</span>
                    <span className="truncate font-mono text-2xs text-fg-muted">{deal.contactDetail.email ?? deal.contactDetail.phone ?? ""}</span>
                  </span>
                </a>
                <dl className="crm-facts grid gap-x-2 gap-y-1">
                  <dt className="text-fg-muted">{t("deal.company")}</dt>
                  <dd className="m-0 text-fg">
                    {deal.companyDetail ? (
                      <a href={`/companies/${deal.companyDetail.id}`}>
                        {[deal.companyDetail.name, deal.companyDetail.sector, deal.companyDetail.city].filter(Boolean).join(", ")}
                      </a>
                    ) : (
                      "–"
                    )}
                  </dd>
                  <dt className="text-fg-muted">{t("common.owner")}</dt>
                  <dd className="m-0 text-fg">{deal.owner?.name ?? t("common.nobody")}</dd>
                  <dt className="text-fg-muted">{t("deal.source")}</dt>
                  <dd className="m-0 text-fg">
                    {sourceLabel(t, deal.source, deal.sourceName)}
                    {deal.sourceDetail ? ` · ${deal.sourceDetail}` : ""}
                  </dd>
                  {deal.companyDetail?.plan && (
                    <>
                      <dt className="text-fg-muted">{t("company.plan")}</dt>
                      <dd className="m-0 text-fg">{deal.companyDetail.plan.name}</dd>
                    </>
                  )}
                </dl>
              </div>
            ) : (
              <p className="text-xs text-fg-muted">{t("deal.noContact")}</p>
            )}
          </Panel>
          <AudiencePanel call={call} dealId={id} />
          <Panel
            title={t("task.next")}
            actions={
              deal.canEdit && (
                <Button size="sm" icon={<Plus />} onClick={() => setDialog("task")}>
                  {t("task.add")}
                </Button>
              )
            }
          >
            {nextTask ? (
              <Checkbox
                label={nextTask.text}
                description={t("task.dueOwner", { due: day(nextTask.due, locale), owner: nextTask.owner?.name ?? t("common.nobody") })}
                checked={false}
                disabled={!deal.canEdit}
                onChange={() => void call(`/api/v1/tasks/${nextTask.id}`, { method: "PATCH", body: JSON.stringify({ done: true }) }).then(reload, fail)}
              />
            ) : (
              <p className="text-xs text-fg-muted">{t("task.noneOpen")}</p>
            )}
          </Panel>
          {deal.sequences.length > 0 && deal.canEdit && (
            <Panel title={t("sequence.title")} description={t("sequence.detail")}>
              <div className="flex flex-col gap-1.5">
                {deal.sequences.map((s) => (
                  <Button
                    key={s.id}
                    size="sm"
                    icon={<Workflow />}
                    disabled={!deal.contact?.email}
                    onClick={() =>
                      post(`/api/v1/deals/${id}/sequences`, { sequence: s.id }, () => setNotice({ text: t("sequence.started", { name: s.name }) }))
                    }
                  >
                    {t("sequence.start", { name: s.name })}
                  </Button>
                ))}
              </div>
            </Panel>
          )}
          <Panel title={t("deal.timeInStage")}>
            <ul aria-label={t("deal.timeInStage")} className="crm-list flex flex-col gap-1 text-xs">
              {deal.timeInStage.map((s) => (
                <li key={s.stage} className="flex justify-between gap-2">
                  <span>{stages.find((x) => x.id === s.stage)?.name ?? (s.stage === "won" || s.stage === "lost" ? t(`status.${s.stage}`) : s.stage)}</span>
                  <span className="font-mono text-fg-muted">{t("overview.daysN", { n: s.days })}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
      {dialog === "log" && (
        <LogActivityDialog call={call} open onOpenChange={(o) => !o && setDialog(null)} target={target} onDone={() => (setDialog(null), reload())} />
      )}
      {dialog === "task" && (
        <AddTaskDialog
          call={call}
          open
          onOpenChange={(o) => !o && setDialog(null)}
          target={target}
          onDone={() => (setDialog(null), reload(), ctx.onChanged())}
        />
      )}
      {(dialog === "lost" || dialog === "won") && (
        <Dialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          title={dialog === "lost" ? t("deal.lostTitle") : t("deal.wonTitle")}
          onSubmit={(e) => {
            e.preventDefault();
            post(`/api/v1/deals/${id}/${dialog}`, { ...(reason && { reason }), ...(note && { note }) }, () => setDialog(null));
          }}
          footer={
            <>
              <Button type="button" onClick={() => setDialog(null)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" variant="primary" disabled={dialog === "lost" && !reason.trim()}>
                {dialog === "lost" ? t("deal.markLost") : t("deal.markWon")}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-2.5">
            {(dialog === "lost" ? deal.lostReasons : deal.wonReasons).length ? (
              <SelectField
                label={t("deal.reason")}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                options={[
                  ...(dialog === "won" ? [{ value: "", label: t("deal.noReason") }] : []),
                  ...(dialog === "lost" ? deal.lostReasons : deal.wonReasons).map((r) => ({ value: r, label: r })),
                ]}
              />
            ) : (
              <TextField label={t("deal.reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
            )}
            <TextField label={t("deal.note")} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </Dialog>
      )}
    </>
  );
}

function DealFields({ call, deal, members, onSaved }: { call: Ctx["call"]; deal: DealDetail; members: Ctx["members"]; onSaved: () => void }) {
  const t = useT();
  const [value, setValue] = useState(String(deal.value));
  const [close, setClose] = useState(deal.expectedClose ?? "");
  const [owner, setOwner] = useState(deal.owner?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const changed = value !== String(deal.value) || close !== (deal.expectedClose ?? "") || owner !== (deal.owner?.id ?? "");
  return (
    <Panel title={t("deal.details")}>
      {error && <Notice tone="danger">{error}</Notice>}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void call(`/api/v1/deals/${deal.id}`, {
            method: "PATCH",
            body: JSON.stringify({ value: Number(value.replace(",", ".")), expectedClose: close || null, owner: owner || null }),
          }).then(
            () => (setError(null), onSaved()),
            (err: Error) => setError(err.message),
          );
        }}
      >
        <TextField
          label={t("deal.value", { currency: deal.currency === "TRY" ? "TL" : deal.currency })}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode="decimal"
        />
        <TextField label={t("deal.expectedClose")} type="date" value={close} onChange={(e) => setClose(e.target.value)} />
        <SelectField
          label={t("common.owner")}
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          options={[{ value: "", label: t("common.nobody") }, ...members.map((m) => ({ value: m.id, label: m.name }))]}
        />
        <Button type="submit" disabled={!changed}>
          {t("common.save")}
        </Button>
      </form>
    </Panel>
  );
}
