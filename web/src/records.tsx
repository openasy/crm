// Companies and the people at them, one company, one contact, and the CSV import.
import {
  Avatar,
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  PageHeader,
  Panel,
  SearchInput,
  SegmentedControl,
  SelectField,
  StatusBadge,
  TextField,
  useLocalePreference,
  type Column,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { Plus, Upload, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Company, CompanyDetail, Contact, ContactDetail, Deal, ImportResult } from "./api.ts";
import type { Ctx } from "./App.tsx";
import { day, money, Notice, sourceLabel, useLoad } from "./common.tsx";
import { ActivityList, AddTaskDialog, LogActivityDialog, NewDealDialog } from "./deals.tsx";
import { useT } from "./i18n.ts";

function OwnerCell({ owner, nobody }: { owner: { name: string } | null; nobody: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {owner && <Avatar name={owner.name} size="sm" className="size-5" />}
      <span className="truncate text-xs">{owner?.name ?? nobody}</span>
    </span>
  );
}

function DealTable({ deals, label }: { deals: Deal[]; label: string }) {
  const t = useT();
  const [locale] = useLocalePreference();
  return (
    <DataTable
      label={label}
      rows={deals}
      getRowId={(d) => d.id}
      minWidth={560}
      onRowClick={(d) => (window.location.href = `/deals/${d.id}`)}
      empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("pipeline.noDeals")}</p>}
      columns={[
        { id: "name", header: t("deal.name"), cell: (d) => <a href={`/deals/${d.id}`}>{d.name}</a> },
        {
          id: "stage",
          header: t("deal.stage"),
          cell: (d) => (
            <StatusBadge tone={d.status === "won" ? "success" : d.status === "lost" ? "danger" : "info"}>
              {d.status === "open" ? d.stage.name : t(`status.${d.status}`)}
            </StatusBadge>
          ),
        },
        { id: "value", header: t("overview.value"), align: "right", mono: true, sortValue: (d) => d.value, cell: (d) => money(d.value, d.currency, locale) },
        { id: "owner", header: t("common.owner"), cell: (d) => <OwnerCell owner={d.owner} nobody={t("common.nobody")} /> },
      ]}
    />
  );
}

export function CompanyDialog({
  call,
  settings,
  members,
  open,
  onOpenChange,
  onSaved,
  company,
}: Ctx & { open: boolean; onOpenChange: (o: boolean) => void; onSaved: (c: Company) => void; company?: Company }) {
  const t = useT();
  const { me } = useAuth();
  const [f, setF] = useState({
    name: company?.name ?? "",
    domain: company?.domain ?? "",
    sector: company?.sector ?? "",
    city: company?.city ?? "",
    plan: company?.plan?.id ?? "",
    planRenews: company?.planRenews ?? "",
    users: company?.users === null || company?.users === undefined ? "" : String(company.users),
    owner: company ? (company.owner?.id ?? "") : me.user.id,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={company ? t("company.edit") : t("company.new")}
      onSubmit={(e) => {
        e.preventDefault();
        const body = {
          ...f,
          domain: f.domain || null,
          sector: f.sector || null,
          city: f.city || null,
          plan: f.plan || null,
          planRenews: f.planRenews || null,
          users: f.users ? Number(f.users) : null,
          owner: f.owner || null,
        };
        void call<Company>(company ? `/api/v1/companies/${company.id}` : "/api/v1/companies", {
          method: company ? "PATCH" : "POST",
          body: JSON.stringify(body),
        }).then(onSaved, (err: Error) => setError(err.message));
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!f.name.trim()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        {error && <Notice tone="danger">{error}</Notice>}
        <TextField label={t("company.name")} value={f.name} onChange={set("name")} required />
        <TextField label={t("company.domain")} value={f.domain} onChange={set("domain")} placeholder="example.com.tr" />
        <TextField label={t("company.sector")} value={f.sector} onChange={set("sector")} />
        <TextField label={t("company.city")} value={f.city} onChange={set("city")} />
        <SelectField
          label={t("company.plan")}
          value={f.plan}
          onChange={set("plan")}
          options={[{ value: "", label: t("company.noPlan") }, ...settings.config.plans.map((p) => ({ value: p.id, label: p.name }))]}
        />
        <TextField label={t("company.renews")} type="date" value={f.planRenews} onChange={set("planRenews")} />
        <TextField label={t("company.users")} value={f.users} onChange={set("users")} inputMode="numeric" />
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

function ContactDialog({
  call,
  members,
  open,
  onOpenChange,
  onSaved,
  contact,
  company,
}: Ctx & { open: boolean; onOpenChange: (o: boolean) => void; onSaved: (c: Contact) => void; contact?: Contact; company?: string }) {
  const t = useT();
  const { me } = useAuth();
  const [f, setF] = useState({
    name: contact?.name ?? "",
    email: contact?.email ?? "",
    phone: contact?.phone ?? "",
    title: contact?.title ?? "",
    companyName: contact?.company?.name ?? "",
    owner: contact ? (contact.owner?.id ?? "") : me.user.id,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={contact ? t("contact.edit") : t("contact.new")}
      onSubmit={(e) => {
        e.preventDefault();
        const body = {
          name: f.name,
          email: f.email || null,
          phone: f.phone || null,
          title: f.title || null,
          ...(company ? { company } : f.companyName.trim() ? { companyName: f.companyName.trim() } : contact ? { company: null } : {}),
          owner: f.owner || null,
        };
        void call<Contact>(contact ? `/api/v1/contacts/${contact.id}` : "/api/v1/contacts", {
          method: contact ? "PATCH" : "POST",
          body: JSON.stringify(body),
        }).then(onSaved, (err: Error) => setError(err.message));
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!f.name.trim()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        {error && <Notice tone="danger">{error}</Notice>}
        <TextField label={t("contact.name")} value={f.name} onChange={set("name")} required />
        <TextField label={t("contact.email")} type="email" value={f.email} onChange={set("email")} hint={t("contact.emailHint")} />
        <TextField label={t("contact.phone")} value={f.phone} onChange={set("phone")} />
        <TextField label={t("contact.title")} value={f.title} onChange={set("title")} />
        {!company && <TextField label={t("deal.company")} value={f.companyName} onChange={set("companyName")} hint={t("deal.companyHint")} />}
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

function ImportDialog({ call, open, onOpenChange, onDone }: { call: Ctx["call"]; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<"companies" | "contacts" | "deals">("contacts");
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (dryRun: boolean) => {
    setError(null);
    void call<ImportResult>("/api/v1/import", { method: "POST", body: JSON.stringify({ kind, csv, dryRun }) }).then(
      (r) => {
        setResult(r);
        if (!dryRun) onDone();
      },
      (err: Error) => setError(err.message),
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t("import.title")}
      description={t(`import.columns.${kind}`)}
      onSubmit={(e) => {
        e.preventDefault();
        run(false);
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
          <Button type="button" disabled={!csv.trim()} onClick={() => run(true)}>
            {t("import.check")}
          </Button>
          <Button type="submit" variant="primary" disabled={!csv.trim()}>
            {t("import.run")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        {error && <Notice tone="danger">{error}</Notice>}
        <SegmentedControl
          label={t("import.kind")}
          value={kind}
          onChange={(k) => (setKind(k), setResult(null))}
          options={(["companies", "contacts", "deals"] as const).map((k) => ({ value: k, label: t(`import.${k}`) }))}
        />
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          {t("import.file")}
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void file.text().then(setCsv);
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          {t("import.paste")}
          <textarea className="crm-textarea font-mono" value={csv} onChange={(e) => setCsv(e.target.value)} />
        </label>
        {result && (
          <div role="status" className="text-sm">
            <p className="m-0">
              {t(result.dryRun ? "import.checked" : "import.done", {
                rows: result.rows,
                created: result.created,
                updated: result.updated,
                skipped: result.skipped,
              })}
            </p>
            {result.ignoredColumns.length > 0 && (
              <p className="m-0 text-xs text-fg-muted">{t("import.ignored", { columns: result.ignoredColumns.join(", ") })}</p>
            )}
            {result.errors.length > 0 && (
              <ul className="crm-list mt-1 flex flex-col gap-0.5 text-xs text-danger-text">
                {result.errors.slice(0, 20).map((e) => (
                  <li key={e.row}>{t("import.rowError", { row: e.row, message: e.message })}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function CompaniesPage(ctx: Ctx) {
  const { call } = ctx;
  const t = useT();
  const [locale] = useLocalePreference();
  const { can } = useAuth();
  const [view, setView] = useState<"companies" | "people">("companies");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<"company" | "contact" | "import" | null>(null);
  const [companies, reloadCompanies] = useLoad<{ companies: Company[] }>(call, "/api/v1/companies");
  const [contacts, reloadContacts] = useLoad<{ contacts: Contact[] }>(call, view === "people" ? "/api/v1/contacts" : null);
  const words = query.toLocaleLowerCase(locale);
  const companyRows = (companies?.companies ?? []).filter((c) => `${c.name} ${c.city ?? ""} ${c.sector ?? ""}`.toLocaleLowerCase(locale).includes(words));
  const contactRows = (contacts?.contacts ?? []).filter((c) => `${c.name} ${c.email ?? ""} ${c.company?.name ?? ""}`.toLocaleLowerCase(locale).includes(words));
  const companyCols: Column<Company>[] = [
    {
      id: "name",
      header: t("company.company"),
      width: "28%",
      sortValue: (c) => c.name,
      cell: (c) => (
        <a href={`/companies/${c.id}`} className="flex min-w-0 flex-col no-underline">
          <span className="truncate font-medium text-fg">{c.name}</span>
          <span className="text-2xs text-fg-muted">{[c.sector, c.city].filter(Boolean).join(" · ") || "–"}</span>
        </a>
      ),
    },
    {
      id: "plan",
      header: t("company.plan"),
      cell: (c) => (c.plan ? <Badge>{c.plan.name}</Badge> : <span className="text-xs text-fg-muted">{t("company.notCustomer")}</span>),
    },
    { id: "contacts", header: t("company.contacts"), align: "right", mono: true, sortValue: (c) => c.contacts, cell: (c) => c.contacts },
    {
      id: "open",
      header: t("company.openDeals"),
      align: "right",
      mono: true,
      sortValue: (c) => c.openValue,
      cell: (c) => (c.openValue ? money(c.openValue, ctx.settings.config.currency, locale) : "–"),
    },
    { id: "owner", header: t("common.owner"), cell: (c) => <OwnerCell owner={c.owner} nobody={t("common.nobody")} /> },
  ];
  const contactCols: Column<Contact>[] = [
    {
      id: "name",
      header: t("contact.name"),
      sortValue: (c) => c.name,
      cell: (c) => (
        <a href={`/contacts/${c.id}`} className="flex min-w-0 flex-col no-underline">
          <span className="truncate font-medium text-fg">{c.name}</span>
          <span className="truncate font-mono text-2xs text-fg-muted">{c.email ?? c.phone ?? ""}</span>
        </a>
      ),
    },
    { id: "company", header: t("deal.company"), cell: (c) => (c.company ? <a href={`/companies/${c.company.id}`}>{c.company.name}</a> : "–") },
    { id: "title", header: t("contact.title"), cell: (c) => c.title ?? "–" },
    { id: "deals", header: t("company.openDeals"), align: "right", mono: true, cell: (c) => c.openDeals },
    { id: "owner", header: t("common.owner"), cell: (c) => <OwnerCell owner={c.owner} nobody={t("common.nobody")} /> },
  ];
  return (
    <>
      <PageHeader
        title={t("companies.title")}
        description={t("companies.description")}
        actions={
          can("editor") && (
            <>
              <Button icon={<Upload />} onClick={() => setDialog("import")}>
                {t("import.title")}
              </Button>
              <Button icon={<Users />} onClick={() => setDialog("contact")}>
                {t("contact.new")}
              </Button>
              <Button variant="primary" icon={<Plus />} onClick={() => setDialog("company")}>
                {t("company.new")}
              </Button>
            </>
          )
        }
      />
      <Panel flush>
        <div className="flex flex-wrap items-end gap-2 px-3 py-2">
          <SegmentedControl
            label={t("companies.show")}
            value={view}
            onChange={setView}
            options={[
              { value: "companies", label: t("companies.companies") },
              { value: "people", label: t("companies.people") },
            ]}
          />
          <SearchInput
            label={view === "companies" ? t("companies.search") : t("companies.searchPeople")}
            placeholder={view === "companies" ? t("companies.searchPlaceholder") : t("companies.searchPeoplePlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="crm-search"
          />
        </div>
        <div className="border-t border-line">
          {view === "companies" ? (
            <DataTable
              label={t("companies.companies")}
              columns={companyCols}
              rows={companyRows}
              getRowId={(c) => c.id}
              defaultSort={{ id: "open", direction: "desc" }}
              minWidth={720}
              loading={companies === undefined}
              empty={<EmptyState title={t("companies.none")} />}
            />
          ) : (
            <DataTable
              label={t("companies.people")}
              columns={contactCols}
              rows={contactRows}
              getRowId={(c) => c.id}
              minWidth={720}
              loading={contacts === undefined}
              empty={<EmptyState title={t("companies.nonePeople")} />}
            />
          )}
        </div>
      </Panel>
      {dialog === "company" && (
        <CompanyDialog {...ctx} open onOpenChange={(o) => !o && setDialog(null)} onSaved={(c) => (window.location.href = `/companies/${c.id}`)} />
      )}
      {dialog === "contact" && (
        <ContactDialog {...ctx} open onOpenChange={(o) => !o && setDialog(null)} onSaved={(c) => (window.location.href = `/contacts/${c.id}`)} />
      )}
      {dialog === "import" && (
        <ImportDialog call={call} open onOpenChange={(o) => !o && setDialog(null)} onDone={() => (reloadCompanies(), reloadContacts())} />
      )}
    </>
  );
}

function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="crm-facts grid gap-x-2 gap-y-1 text-xs">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-fg-muted">{k}</dt>
          <dd className="m-0 min-w-0 text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CompanyPage(ctx: Ctx & { id: string }) {
  const { call, id } = ctx;
  const t = useT();
  const [locale] = useLocalePreference();
  const [c, reload] = useLoad<CompanyDetail>(call, `/api/v1/companies/${id}`);
  const [dialog, setDialog] = useState<"edit" | "contact" | "deal" | "log" | null>(null);
  if (c === undefined) return <PageHeader title={t("loading")} />;
  if (c === null) return <PageHeader title={t("company.notFound")} breadcrumbs={[{ label: t("nav.companies"), href: "/companies" }]} />;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t("nav.companies"), href: "/companies" }, { label: c.name }]}
        title={c.name}
        description={[c.sector, c.city, c.domain].filter(Boolean).join(" · ") || undefined}
        meta={c.plan ? <Badge>{c.plan.name}</Badge> : undefined}
        actions={
          c.canEdit && (
            <>
              <Button onClick={() => setDialog("edit")}>{t("common.edit")}</Button>
              <Button icon={<Users />} onClick={() => setDialog("contact")}>
                {t("contact.new")}
              </Button>
              <Button variant="primary" icon={<Plus />} onClick={() => setDialog("deal")}>
                {t("deal.new")}
              </Button>
            </>
          )
        }
      />
      <div className="crm-side grid gap-2.5">
        <div className="flex min-w-0 flex-col gap-2.5">
          <Panel title={t("companies.people")} flush>
            <DataTable
              label={t("companies.people")}
              rows={c.people}
              getRowId={(x) => x.id}
              minWidth={480}
              empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("companies.nonePeople")}</p>}
              columns={[
                { id: "name", header: t("contact.name"), cell: (x) => <a href={`/contacts/${x.id}`}>{x.name}</a> },
                { id: "title", header: t("contact.title"), cell: (x) => x.title ?? "–" },
                { id: "email", header: t("contact.email"), cell: (x) => <span className="font-mono text-xs">{x.email ?? "–"}</span> },
              ]}
            />
          </Panel>
          <Panel title={t("company.deals")} flush>
            <DealTable deals={c.deals} label={t("company.deals")} />
          </Panel>
          <Panel
            title={t("activity.title")}
            actions={
              c.canEdit && (
                <Button size="sm" icon={<Plus />} onClick={() => setDialog("log")}>
                  {t("activity.log")}
                </Button>
              )
            }
          >
            <ActivityList activities={c.activities} t={t} locale={locale} />
          </Panel>
        </div>
        <Panel title={t("company.about")}>
          <Facts
            items={[
              [
                t("company.plan"),
                c.plan ? `${c.plan.name}${c.planRenews ? `, ${t("company.renewsOn", { day: day(c.planRenews, locale) })}` : ""}` : t("company.notCustomer"),
              ],
              [t("company.users"), c.users ?? "–"],
              [t("company.openDeals"), money(c.openValue, ctx.settings.config.currency, locale)],
              [t("common.owner"), c.owner?.name ?? t("common.nobody")],
            ]}
          />
        </Panel>
      </div>
      {dialog === "edit" && <CompanyDialog {...ctx} company={c} open onOpenChange={(o) => !o && setDialog(null)} onSaved={() => (setDialog(null), reload())} />}
      {dialog === "contact" && (
        <ContactDialog {...ctx} company={c.id} open onOpenChange={(o) => !o && setDialog(null)} onSaved={() => (setDialog(null), reload())} />
      )}
      {dialog === "deal" && (
        <NewDealDialog
          {...ctx}
          company={c.name}
          open
          onOpenChange={(o) => !o && setDialog(null)}
          onCreated={(d) => (window.location.href = `/deals/${d.id}`)}
        />
      )}
      {dialog === "log" && (
        <LogActivityDialog call={call} open onOpenChange={(o) => !o && setDialog(null)} target={{ company: c.id }} onDone={() => (setDialog(null), reload())} />
      )}
    </>
  );
}

export function ContactPage(ctx: Ctx & { id: string }) {
  const { call, id } = ctx;
  const t = useT();
  const [locale] = useLocalePreference();
  const [c, reload] = useLoad<ContactDetail>(call, `/api/v1/contacts/${id}`);
  const [dialog, setDialog] = useState<"edit" | "log" | "task" | null>(null);
  if (c === undefined) return <PageHeader title={t("loading")} />;
  if (c === null) return <PageHeader title={t("contact.notFound")} breadcrumbs={[{ label: t("nav.companies"), href: "/companies" }]} />;
  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: t("nav.companies"), href: "/companies" },
          ...(c.company ? [{ label: c.company.name, href: `/companies/${c.company.id}` }] : []),
          { label: c.name },
        ]}
        title={c.name}
        description={[c.title, c.company?.name].filter(Boolean).join(", ") || undefined}
        actions={
          c.canEdit && (
            <>
              <Button onClick={() => setDialog("task")}>{t("task.add")}</Button>
              <Button onClick={() => setDialog("log")}>{t("activity.log")}</Button>
              <Button onClick={() => setDialog("edit")}>{t("common.edit")}</Button>
            </>
          )
        }
      />
      <div className="crm-side grid gap-2.5">
        <div className="flex min-w-0 flex-col gap-2.5">
          <Panel title={t("company.deals")} flush>
            <DealTable deals={c.deals} label={t("company.deals")} />
          </Panel>
          <Panel title={t("activity.title")}>
            <ActivityList activities={c.activities} t={t} locale={locale} />
          </Panel>
        </div>
        <div className="flex flex-col gap-2.5">
          <Panel title={t("contact.about")}>
            <Facts
              items={[
                [
                  t("contact.email"),
                  <span key="email" className="font-mono">
                    {c.email ?? "–"}
                  </span>,
                ],
                [t("contact.phone"), c.phone ?? "–"],
                [
                  t("deal.company"),
                  c.company ? (
                    <a key="company" href={`/companies/${c.company.id}`}>
                      {c.company.name}
                    </a>
                  ) : (
                    "–"
                  ),
                ],
                [t("common.owner"), c.owner?.name ?? t("common.nobody")],
                [t("deal.source"), sourceLabel(t, c.source)],
              ]}
            />
          </Panel>
          <Panel title={t("nav.tasks")}>
            {c.tasks.length ? (
              <ul className="crm-list flex flex-col gap-1 text-xs">
                {c.tasks.map((x) => (
                  <li key={x.id} className={x.doneAt ? "text-fg-muted line-through" : "text-fg"}>
                    {x.text} · {day(x.due, locale)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-fg-muted">{t("task.noneOpen")}</p>
            )}
          </Panel>
        </div>
      </div>
      {dialog === "edit" && <ContactDialog {...ctx} contact={c} open onOpenChange={(o) => !o && setDialog(null)} onSaved={() => (setDialog(null), reload())} />}
      {dialog === "log" && (
        <LogActivityDialog call={call} open onOpenChange={(o) => !o && setDialog(null)} target={{ contact: c.id }} onDone={() => (setDialog(null), reload())} />
      )}
      {dialog === "task" && (
        <AddTaskDialog
          call={call}
          open
          onOpenChange={(o) => !o && setDialog(null)}
          target={{ contact: c.id }}
          onDone={() => (setDialog(null), reload(), ctx.onChanged())}
        />
      )}
    </>
  );
}
