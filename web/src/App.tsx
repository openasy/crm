import {
  AppShell,
  Avatar,
  Badge,
  BarList,
  BrandProvider,
  Button,
  Callout,
  DataTable,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  SelectField,
  StackedBarChart,
  toLocale,
  usePath,
  useLocalePreference,
  useThemePreference,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import {
  Building2,
  CalendarDays,
  CheckSquare,
  Handshake,
  Kanban,
  KeyRound,
  LayoutDashboard,
  LogIn,
  LogOut,
  Plug,
  Settings as SettingsIcon,
  Trophy,
  UserRound,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Company, Contact, Deal, Member, ProductLink, Report, Settings, Summary } from "./api.ts";
import { money, monthName, useApi, useLoad, type Call } from "./common.tsx";
import { DealPage, PipelinePage } from "./deals.tsx";
import { useT } from "./i18n.ts";
import { IntegrationsPage, MeetingsPage, SettingsFilePage, TasksPage } from "./pages.tsx";
import { CompaniesPage, CompanyPage, ContactPage } from "./records.tsx";

const PAGES = ["pipeline", "companies", "tasks", "meetings", "integrations", "settings", "account", "members", "signin", "tokens"] as const;
type Page = (typeof PAGES)[number];
type Route = { page: "overview" | Page } | { page: "deal" | "company" | "contact"; id: string };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["overview", ...PAGES, "deals", "contacts"];
function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if (page === "deals" && id) return { page: "deal", id: decodeURIComponent(id) };
  if (page === "companies" && id) return { page: "company", id: decodeURIComponent(id) };
  if (page === "contacts" && id) return { page: "contact", id: decodeURIComponent(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as Page };
  return { page: "overview" };
}

export interface Ctx {
  call: Call;
  settings: Settings & { config: NonNullable<Settings["config"]> };
  members: Member[];
  onChanged: () => void;
}

// ---------------------------------------------------------------- Overview

function OverviewPage({ call, settings }: Ctx) {
  const t = useT();
  const [locale] = useLocalePreference();
  const c = settings.config;
  const [pipeline, setPipeline] = useState(c.pipelines[0]!.id);
  const [r] = useLoad<Report>(call, `/api/v1/report?pipeline=${encodeURIComponent(pipeline)}`);
  const tl = (n: number) => money(n, c.currency, locale);
  const now = r?.forecast[0];
  const rateDelta = r && r.winRate.rate !== null && r.winRate.before !== null ? Math.round((r.winRate.rate - r.winRate.before) * 10) / 10 : null;
  return (
    <>
      <PageHeader
        title={t("overview.title")}
        description={r ? t("overview.description", { month: monthName(r.month, locale, true) }) : undefined}
        actions={
          c.pipelines.length > 1 && (
            <SelectField
              label={t("overview.pipeline")}
              value={pipeline}
              onChange={(e) => setPipeline(e.target.value)}
              options={c.pipelines.map((p) => ({ value: p.id, label: p.name }))}
            />
          )
        }
      />
      {r === null && <EmptyState title={t("common.failed")} />}
      {r && now && (
        <>
          <KpiGrid minWidth={170} className="mb-2.5">
            <KpiCard label={t("overview.open")} value={tl(r.open.value)} delta={{ label: t("overview.deals", { count: r.open.count }), intent: "neutral" }} />
            <KpiCard
              label={t("overview.forecast", { month: monthName(r.month, locale, true) })}
              value={tl(now.total)}
              delta={{ label: t("overview.forecastDetail"), intent: "neutral" }}
            />
            <KpiCard
              label={t("overview.won", { month: monthName(r.month, locale, true) })}
              value={tl(r.won.value)}
              icon={Trophy}
              delta={{ label: t("overview.deals", { count: r.won.count }), intent: "neutral" }}
            />
            <KpiCard
              label={t("overview.winRate")}
              value={r.winRate.rate === null ? "–" : `${r.winRate.rate}%`}
              delta={
                rateDelta === null
                  ? { label: t("overview.winRateOf", { won: r.winRate.won, lost: r.winRate.lost }), intent: "neutral" }
                  : {
                      label: t("overview.points", { n: (rateDelta > 0 ? "+" : "") + rateDelta }),
                      direction: rateDelta > 0 ? "up" : rateDelta < 0 ? "down" : "flat",
                      intent: rateDelta >= 0 ? "good" : "bad",
                    }
              }
            />
            <KpiCard
              label={t("overview.stale")}
              value={String(r.stale)}
              tone={r.stale ? "warning" : undefined}
              delta={{ label: t("overview.staleDetail"), intent: r.stale ? "bad" : "neutral" }}
            />
          </KpiGrid>
          <div className="crm-side mb-2.5 grid gap-2.5">
            <Panel title={t("overview.wonLost")} description={t("overview.wonLostDetail")}>
              <StackedBarChart
                label={t("overview.wonLostLabel")}
                categories={r.history.map((h) => monthName(h.month, locale))}
                segments={[
                  { id: "won", name: t("status.won"), color: "var(--oa-success)" },
                  { id: "lost", name: t("status.lost"), color: "var(--oa-danger)" },
                ]}
                values={r.history.map((h) => [h.won, h.lost])}
                height={200}
                xTicks={6}
                format={tl}
              />
            </Panel>
            <Panel title={t("overview.reasons")} description={t("overview.days90")}>
              {r.lostReasons.length ? (
                <BarList label={t("overview.reasonsLabel")} items={r.lostReasons.map((x) => ({ id: x.reason, label: x.reason, value: x.count }))} />
              ) : (
                <p className="text-sm text-fg-muted">{t("overview.noLost")}</p>
              )}
            </Panel>
          </div>
          <div className="crm-halves mb-2.5 grid gap-2.5">
            <Panel title={t("overview.forecastMonths")} description={t("overview.forecastMonthsDetail")} flush>
              <DataTable
                label={t("overview.forecastMonths")}
                rows={r.forecast}
                getRowId={(f) => f.month}
                minWidth={420}
                columns={[
                  { id: "month", header: t("overview.month"), cell: (f) => monthName(f.month, locale, true) },
                  { id: "won", header: t("status.won"), align: "right", mono: true, cell: (f) => tl(f.won) },
                  { id: "weighted", header: t("overview.weighted"), align: "right", mono: true, cell: (f) => tl(f.weighted) },
                  { id: "total", header: t("overview.total"), align: "right", mono: true, cell: (f) => <strong>{tl(f.total)}</strong> },
                  {
                    id: "deals",
                    header: t("overview.openDeals"),
                    align: "right",
                    mono: true,
                    cell: (f) => (f.overdue ? <Badge tone="warning">{t("overview.withOverdue", { n: f.deals, overdue: f.overdue })}</Badge> : f.deals),
                  },
                ]}
              />
            </Panel>
            <Panel title={t("overview.timeInStage")} description={t("overview.timeInStageDetail")} flush>
              <DataTable
                label={t("overview.timeInStage")}
                rows={r.stages}
                getRowId={(s) => s.id}
                minWidth={420}
                columns={[
                  { id: "stage", header: t("overview.stage"), cell: (s) => `${s.name} · ${s.probability}%` },
                  { id: "open", header: t("overview.openDeals"), align: "right", mono: true, cell: (s) => s.open },
                  { id: "value", header: t("overview.value"), align: "right", mono: true, cell: (s) => tl(s.value) },
                  {
                    id: "avg",
                    header: t("overview.avgDays"),
                    align: "right",
                    mono: true,
                    cell: (s) => (s.avgDays === null ? "–" : t("overview.daysN", { n: s.avgDays })),
                  },
                ]}
              />
            </Panel>
          </div>
          <Panel title={t("overview.byOwner")} flush>
            <DataTable
              label={t("overview.byOwner")}
              rows={r.owners}
              getRowId={(o) => o.owner?.id ?? "none"}
              minWidth={640}
              empty={<p className="px-3 py-3 text-sm text-fg-muted">{t("overview.noDeals")}</p>}
              columns={[
                {
                  id: "owner",
                  header: t("common.owner"),
                  cell: (o) => (
                    <span className="flex items-center gap-2">
                      <Avatar name={o.owner?.name ?? "?"} size="sm" />
                      {o.owner?.name ?? t("common.nobody")}
                    </span>
                  ),
                },
                { id: "deals", header: t("overview.openDeals"), align: "right", mono: true, cell: (o) => o.deals },
                { id: "value", header: t("overview.value"), align: "right", mono: true, sortValue: (o) => o.value, cell: (o) => tl(o.value) },
                { id: "weighted", header: t("overview.weighted"), align: "right", mono: true, sortValue: (o) => o.weighted, cell: (o) => tl(o.weighted) },
                { id: "forecast", header: t("overview.forecastShort"), align: "right", mono: true, sortValue: (o) => o.forecast, cell: (o) => tl(o.forecast) },
                {
                  id: "stale",
                  header: t("overview.staleShort"),
                  align: "right",
                  cell: (o) => (o.stale ? <Badge tone="warning">{o.stale}</Badge> : <span className="text-xs text-fg-muted">0</span>),
                },
              ]}
            />
          </Panel>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function AuthSettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("auth.adminsOnly")}>{t("auth.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`auth.${page}`)}
        description={t(`auth.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("auth.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [settings, setSettings] = useState<Settings>();
  const [members, setMembers] = useState<Member[]>([]);
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();

  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) => setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "crm" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
    void call<{ members: Member[] }>("/api/v1/team").then(
      (r) => setMembers(r.members),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => {
    void call<Summary>("/api/v1/summary").then(setSummary, () => {});
    void call<Settings>("/api/v1/settings").then(setSettings, () => {});
  }, [call]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, [reload]);

  // The search window (Cmd+K) finds deals, companies and contacts.
  const onSearch = useMemo(
    () => async (q: string, signal: AbortSignal) => {
      const p = new URLSearchParams({ q });
      const [d, co, ct] = await Promise.all([
        call<{ deals: Deal[] }>(`/api/v1/deals?status=all&${p}`, { signal }),
        call<{ companies: Company[] }>(`/api/v1/companies?${p}`, { signal }),
        call<{ contacts: Contact[] }>(`/api/v1/contacts?${p}`, { signal }),
      ]);
      return [
        ...d.deals.slice(0, 6).map((x) => ({
          id: `deal:${x.id}`,
          label: x.company ? `${x.company.name}: ${x.name}` : x.name,
          detail: x.stage.name,
          kind: msg("search.deal"),
          icon: Handshake,
          href: `/deals/${x.id}`,
        })),
        ...co.companies.slice(0, 4).map((x) => ({
          id: `company:${x.id}`,
          label: x.name,
          detail: x.city ?? "",
          kind: msg("search.company"),
          icon: Building2,
          href: `/companies/${x.id}`,
        })),
        ...ct.contacts.slice(0, 4).map((x) => ({
          id: `contact:${x.id}`,
          label: x.name,
          detail: x.email ?? "",
          kind: msg("search.contact"),
          icon: UserRound,
          href: `/contacts/${x.id}`,
        })),
      ];
    },
    [call, msg],
  );

  const nav = [
    { id: "overview", label: msg("nav.overview"), icon: LayoutDashboard },
    { id: "pipeline", label: msg("nav.pipeline"), icon: Kanban, count: summary?.stale || undefined },
    { id: "companies", label: msg("nav.companies"), icon: Building2 },
    { id: "tasks", label: msg("nav.tasks"), icon: CheckSquare, count: summary?.tasksDue || undefined },
    { id: "meetings", label: msg("nav.meetings"), icon: CalendarDays },
  ];
  const footerNav = [
    { id: "integrations", label: msg("nav.integrations"), icon: Plug },
    { id: "settings", label: msg("nav.settings"), icon: SettingsIcon },
    ...(can("admin")
      ? [
          { id: "members", label: msg("nav.members"), icon: Users },
          { id: "signin", label: msg("nav.signIn"), icon: LogIn },
          { id: "tokens", label: msg("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("nav.account"), icon: UserRound },
  ];
  const active = route.page === "deal" ? "pipeline" : route.page === "company" || route.page === "contact" ? "companies" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const ready = settings?.config ? (settings as Ctx["settings"]) : undefined;
  const ctx = ready && { call, settings: ready, members, onChanged: reload };

  return (
    <AppShell
      product="crm"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {summary?.file?.error && route.page !== "settings" && (
        <Callout tone="danger" title={msg("file.notApplied")} className="mb-2.5">
          {summary.file.error}
        </Callout>
      )}
      {route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <AuthSettingsPage page={route.page} />
      ) : !ctx ? (
        <PageHeader title={msg("loading")} />
      ) : route.page === "pipeline" ? (
        <PipelinePage {...ctx} />
      ) : route.page === "deal" ? (
        <DealPage key={route.id} {...ctx} id={route.id} />
      ) : route.page === "companies" ? (
        <CompaniesPage {...ctx} />
      ) : route.page === "company" ? (
        <CompanyPage key={route.id} {...ctx} id={route.id} />
      ) : route.page === "contact" ? (
        <ContactPage key={route.id} {...ctx} id={route.id} />
      ) : route.page === "tasks" ? (
        <TasksPage {...ctx} />
      ) : route.page === "meetings" ? (
        <MeetingsPage {...ctx} />
      ) : route.page === "integrations" ? (
        <IntegrationsPage {...ctx} />
      ) : route.page === "settings" ? (
        <SettingsFilePage {...ctx} />
      ) : (
        <OverviewPage {...ctx} />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy CRM">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
