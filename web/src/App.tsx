import {
  AppShell,
  Badge,
  BrandProvider,
  Button,
  Callout,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  IconButton,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  SegmentedControl,
  SelectField,
  StatusBadge,
  TextField,
  TimeRangePicker,
  TimeSeriesChart,
  formatBytes,
  toLocale,
  useAgo,
  useLocalePreference,
  usePath,
  useThemePreference,
  type Column,
  type ProductId,
  type Tone,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import {
  ArrowRight,
  CircleDot,
  Crosshair,
  Flame,
  GitCompare,
  KeyRound,
  Layers,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  UserRound,
  Users,
  Wrench,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  MfaSetupRequired,
  PULL_TYPES,
  Unauthorized,
  type Capture,
  type Comparison,
  type FlameGraph,
  type Frame,
  type FunctionChange,
  type FunctionStat,
  type ProductLink,
  type ProfileType,
  type PullType,
  type ServiceInfo,
  type Summary,
  type Target,
  type TargetAuth,
  type Timeline,
} from "./api.ts";
import { useT, type T } from "./i18n.ts";
import { baselineOf, colorOf, cores, formatShare, formatValue, isCpuTime, layout, packageOf, pathTo, percent, periodOf, type Baseline } from "./profile.ts";

const PAGES = ["profiles", "flame-graph", "compare", "targets", "setup", "account", "members", "signin", "tokens"] as const;
type Page = (typeof PAGES)[number];
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = [...PAGES];
function parsePage(path: string): Page {
  const page = path.replace(/^\//, "").split("/")[0] ?? "";
  return (PAGES as readonly string[]).includes(page) ? (page as Page) : "profiles";
}

/** A query parameter of the address. */
const param = (name: string) => new URLSearchParams(window.location.search).get(name);
/** Keeps the page's choices in the address, so it can be shared and reloaded, without opening the page again. */
function keepQuery(values: Record<string, string | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v) q.set(k, v);
  const next = `${window.location.pathname}${q.size ? `?${q}` : ""}`;
  if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", next);
}

/** Data loading with the session; when it ends, the sign-in screen comes back. */
function useApi() {
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
type Call = ReturnType<typeof useApi>;

/** Reads a path whenever it changes; `error` is set when it fails. */
function useData<R>(call: Call, path: string | null, tick = 0) {
  const [state, setState] = useState<{ data?: R; error?: string; path?: string }>({});
  useEffect(() => {
    if (!path) return setState({});
    let live = true;
    void call<R>(path).then(
      (data) => live && setState({ data, path }),
      (err: Error) => live && setState({ error: err.message, path }),
    );
    return () => {
      live = false;
    };
  }, [call, path, tick]);
  // Until the new path answers, the old answer is not shown as if it were the new one's.
  return state.path === path ? state : {};
}

/** Runs a change and reports its error, the way every form here does. */
function useAction(after: () => void) {
  const [error, setError] = useState<string>();
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        setError(undefined);
        after();
        return true;
      } catch (err) {
        setError((err as Error).message);
        return false;
      }
    },
    [after],
  );
  return [run, error, setError] as const;
}

/** The time a page reads its period up to: now, moved on every so often and on demand. */
function useNow(every: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!every) return;
    const id = setInterval(() => setNow(Date.now()), every * 1000);
    return () => clearInterval(id);
  }, [every]);
  return [now, () => setNow(Date.now())] as const;
}

/** Reads again every so often while the page is open. */
function useTick(every: number) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!every) return;
    const id = setInterval(() => setTick((n) => n + 1), every * 1000);
    return () => clearInterval(id);
  }, [every]);
  return [tick, () => setTick((n) => n + 1)] as const;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const qs = (values: Record<string, string | number | undefined | string[]>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) {
    if (Array.isArray(v)) for (const x of v) q.append(k, x);
    else if (v !== undefined && v !== "") q.set(k, String(v));
  }
  return q.toString();
};

function Code({ children }: { children: ReactNode }) {
  return <pre className="m-0 overflow-x-auto rounded-md bg-subtle px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-fg">{children}</pre>;
}

function ErrorText({ message }: { message?: string }) {
  return message ? <p className="m-0 text-xs text-danger">{message}</p> : null;
}

/** The types the screens name in words; any other is shown as Pyroscope names it. */
const TYPE_NAMES = {
  "process_cpu:cpu": "types.process_cpu_cpu",
  "process_cpu:samples": "types.process_cpu_samples",
  "wall:wall": "types.wall_wall",
  "memory:alloc_space": "types.memory_alloc_space",
  "memory:alloc_objects": "types.memory_alloc_objects",
  "memory:inuse_space": "types.memory_inuse_space",
  "memory:inuse_objects": "types.memory_inuse_objects",
  "goroutines:goroutine": "types.goroutines_goroutine",
  "goroutine:goroutine": "types.goroutine_goroutine",
  "mutex:contentions": "types.mutex_contentions",
  "mutex:delay": "types.mutex_delay",
  "block:contentions": "types.block_contentions",
  "block:delay": "types.block_delay",
} as const;
function typeName(t: T, type: ProfileType): string {
  const key = TYPE_NAMES[`${type.name}:${type.sampleType}` as keyof typeof TYPE_NAMES];
  return key ? t(key) : `${type.name} · ${type.sampleType}`;
}

const STATUS_TONE: Record<Capture["status"], Tone> = { capturing: "info", stored: "success", failed: "danger" };

function CaptureBadge({ status }: { status: Capture["status"] }) {
  const t = useT();
  return <StatusBadge tone={STATUS_TONE[status]}>{t(`captureStatus.${status}`)}</StatusBadge>;
}

// ---------------------------------------------------------------- Flame graph

/** An icicle flame graph of buttons: width is the share of the value, a click zooms into a frame. */
function FlameGraphView({ root, zoom, unit, onZoom }: { root: Frame; zoom: Frame; unit: string; onZoom: (f: Frame) => void }) {
  const t = useT();
  const [hover, setHover] = useState<Frame | null>(null);
  const rows = useMemo(() => layout(zoom), [zoom]);
  const shown = hover ?? zoom;
  return (
    <div className="flex flex-col gap-2">
      <p aria-live="polite" data-testid="frame-info" className="profiling-frame-info m-0 text-xs">
        <span className="profiling-wrap font-mono font-semibold">{shown.name}</span>
        <span className="text-fg-muted">
          {t("flame.self")} <span className="font-mono text-fg">{formatShare(percent(shown.self, root.total))}</span>
        </span>
        <span className="text-fg-muted">
          {t("flame.total")} <span className="font-mono text-fg">{formatShare(percent(shown.total, root.total))}</span>
        </span>
        <span className="font-mono text-fg">{formatValue(unit, shown.total)}</span>
      </p>
      <div className="profiling-flame" role="group" aria-label={t("flame.graph")}>
        {rows.map((row, depth) => (
          <div key={depth} className="profiling-flame-row">
            {row.map((p) => {
              const w = zoom.total ? p.frame.total / zoom.total : 0;
              const color = p.frame === root ? "var(--oa-line-strong)" : colorOf(p.frame.name);
              return (
                <button
                  key={p.key}
                  type="button"
                  className={`profiling-frame${hover === p.frame ? " profiling-frame-hover" : ""}`}
                  title={`${p.frame.name} · ${formatValue(unit, p.frame.total)}`}
                  onClick={() => onZoom(p.frame)}
                  onMouseEnter={() => setHover(p.frame)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(p.frame)}
                  onBlur={() => setHover(null)}
                  style={{
                    left: `${zoom.total ? (p.x / zoom.total) * 100 : 0}%`,
                    width: `calc(${w * 100}% - 1px)`,
                    borderLeftColor: color,
                    background: `color-mix(in srgb, ${color} 22%, var(--oa-surface))`,
                  }}
                >
                  {p.frame.name === "total" && p.frame === root ? t("flame.all") : p.frame.name}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function FunctionsTable({ functions, total, unit, label }: { functions: FunctionStat[]; total: number; unit: string; label: string }) {
  const t = useT();
  const maxSelf = Math.max(1, ...functions.map((f) => f.self));
  const columns: Column<FunctionStat>[] = [
    {
      id: "name",
      header: t("functions.function"),
      width: "46%",
      sortValue: (f) => f.name,
      cell: (f) => (
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="profiling-swatch" style={{ background: colorOf(f.name) }} />
          <span className="profiling-wrap font-mono text-xs">{f.name}</span>
        </span>
      ),
    },
    { id: "package", header: t("functions.package"), cell: (f) => <span className="profiling-wrap text-xs text-fg-muted">{packageOf(f.name)}</span> },
    {
      id: "self",
      header: t("functions.self"),
      align: "right",
      mono: true,
      description: t("functions.selfDetail"),
      sortValue: (f) => f.self,
      cell: (f) => (
        <span className="flex items-center justify-end gap-2">
          <span aria-hidden className="profiling-meter">
            <span style={{ width: `${(f.self / maxSelf) * 100}%` }} />
          </span>
          {formatShare(percent(f.self, total))}
        </span>
      ),
    },
    {
      id: "total",
      header: t("functions.total"),
      align: "right",
      mono: true,
      description: t("functions.totalDetail"),
      sortValue: (f) => f.total,
      cell: (f) => formatShare(percent(f.total, total)),
    },
    { id: "value", header: t("functions.value"), align: "right", mono: true, sortValue: (f) => f.self, cell: (f) => formatValue(unit, f.self) },
  ];
  return <DataTable label={label} columns={columns} rows={functions} getRowId={(f) => f.name} defaultSort={{ id: "self", direction: "desc" }} minWidth={760} />;
}

/** Service, type and labels picked from what Pyroscope has in the period. */
function useServices(call: Call, period: { from: number; to: number }) {
  // The period moves with every render; the list is read again when its minute changes.
  const minute = Math.floor(period.to / 60_000);
  const path = `/api/v1/services?${qs({ from: Math.floor(period.from / 60_000) * 60_000, to: (minute + 1) * 60_000 })}`;
  return useData<{ services: ServiceInfo[] }>(call, path).data?.services;
}

function ServicePicker({
  services,
  service,
  type,
  onChange,
}: {
  services: ServiceInfo[];
  service: string;
  type: string;
  onChange: (service: string, type: string) => void;
}) {
  const t = useT();
  const current = services.find((s) => s.name === service);
  return (
    <>
      <SelectField
        label={t("pick.service")}
        value={service}
        onChange={(e) => onChange(e.target.value, services.find((s) => s.name === e.target.value)?.types[0]?.id ?? "")}
        options={[...(current ? [] : [{ value: service, label: service || t("pick.none") }]), ...services.map((s) => ({ value: s.name, label: s.name }))]}
      />
      <SelectField
        label={t("pick.type")}
        value={type}
        onChange={(e) => onChange(service, e.target.value)}
        options={(current?.types.length ? current.types : [{ id: type, name: type, sampleType: "", unit: "" }]).map((x) => ({
          value: x.id,
          label: x.sampleType ? typeName(t, x) : x.id || t("pick.none"),
        }))}
      />
    </>
  );
}

function FlameGraphPage({ call }: { call: Call }) {
  const t = useT();
  const [range, setRange] = useState(param("range") ?? "1h");
  const [service, setService] = useState(param("service") ?? "");
  const [type, setType] = useState(param("type") ?? "");
  const [label, setLabel] = useState(param("label") ?? "");
  const [now, refresh] = useNow(0);
  const period = useMemo(() => periodOf(range, now), [range, now]);
  const services = useServices(call, period);

  // With nothing picked, the first service with profiles and its most useful type.
  useEffect(() => {
    if (service || !services?.length) return;
    const first = services.find((s) => s.types.length);
    if (first) (setService(first.name), setType(first.types[0]!.id));
  }, [services, service]);
  useEffect(() => keepQuery({ service, type, range, label }), [service, type, range, label]);

  const labels = useData<{ labels: Record<string, string[]> }>(call, service ? `/api/v1/services/${encodeURIComponent(service)}/labels?${qs(period)}` : null)
    .data?.labels;
  const path = service && type ? `/api/v1/flamegraph?${qs({ service, type, ...period, label: label ? [label] : [] })}` : null;
  const { data: fg, error } = useData<FlameGraph>(call, path);
  const [zoom, setZoom] = useState<Frame | null>(null);
  useEffect(() => setZoom(null), [fg]);
  const shown = fg ? (zoom ?? fg.root) : null;
  const crumbs = fg && shown ? (pathTo(shown, fg.root) ?? [fg.root]) : [];
  const ms = period.to - period.from;
  const hottest = fg?.functions[0];

  return (
    <>
      <PageHeader
        title={t("flamePage.title")}
        description={t("flamePage.description")}
        actions={
          <>
            <TimeRangePicker value={range} onChange={setRange} />
            <IconButton label={t("flamePage.refresh")} onClick={refresh}>
              <RefreshCw />
            </IconButton>
            <Button icon={<GitCompare />} disabled={!service || !type} onClick={() => navigate(`/compare?${qs({ service, type, range, label })}`)}>
              {t("flamePage.compare")}
            </Button>
          </>
        }
      />
      {services && !services.some((s) => s.types.length) ? (
        <Panel>
          <EmptyState icon={<Flame />} title={t("flamePage.none")} action={<Button onClick={() => navigate("/setup")}>{t("flamePage.setup")}</Button>}>
            {t("flamePage.noneDetail")}
          </EmptyState>
        </Panel>
      ) : (
        <>
          <Panel aria-label={t("flamePage.choose")}>
            <div className="profiling-pickers">
              <ServicePicker
                services={services ?? []}
                service={service}
                type={type}
                onChange={(s, ty) => {
                  if (s !== service) setLabel("");
                  setService(s);
                  setType(ty);
                }}
              />
              <SelectField
                label={t("pick.label")}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                options={[
                  { value: "", label: t("pick.allProfiles") },
                  ...Object.entries(labels ?? {}).flatMap(([k, vs]) => vs.map((v) => ({ value: `${k}=${v}`, label: `${k} = ${v}` }))),
                ]}
              />
            </div>
          </Panel>
          {error && (
            <Callout tone="danger" title={t("flamePage.failed")}>
              {error}
            </Callout>
          )}
          {fg && (
            <KpiGrid>
              <KpiCard
                label={isCpuTime(fg.type) ? t("flamePage.cores") : t("flamePage.total")}
                value={isCpuTime(fg.type) ? cores(fg.total, ms).toFixed(2) : formatValue(fg.type.unit, fg.total)}
                unit={isCpuTime(fg.type) ? t("flamePage.coresUnit") : typeName(t, fg.type)}
                delta={isCpuTime(fg.type) ? { label: t("flamePage.cpuTime", { time: formatValue(fg.type.unit, fg.total) }) } : undefined}
              />
              <KpiCard
                label={t("flamePage.hottest")}
                value={<span className="profiling-wrap font-mono text-base">{hottest?.name ?? "–"}</span>}
                delta={hottest ? { label: t("flamePage.hottestSelf", { share: formatShare(percent(hottest.self, fg.total)) }) } : undefined}
              />
              <KpiCard label={t("flamePage.functions")} value={fg.functions.length >= 100 ? "100+" : fg.functions.length} />
            </KpiGrid>
          )}
          <Panel title={fg ? t("flamePage.graphOf", { type: typeName(t, fg.type) }) : t("flamePage.graph")} description={t("flamePage.graphDetail")}>
            {!fg || !shown ? (
              <EmptyState icon={<Flame />} title={path ? t("product.loading") : t("flamePage.pick")} />
            ) : !fg.total ? (
              <EmptyState icon={<Flame />} title={t("flamePage.empty")}>
                {t("flamePage.emptyDetail")}
              </EmptyState>
            ) : (
              <div className="flex flex-col gap-2">
                <nav aria-label={t("flame.zoomPath")}>
                  <ol className="profiling-crumbs text-xs">
                    {crumbs.map((f, i) => (
                      <Fragment key={i}>
                        <li>
                          {i < crumbs.length - 1 ? (
                            <Button size="xs" variant="ghost" className="font-mono" onClick={() => setZoom(f)}>
                              {f === fg.root ? t("flame.all") : f.name}
                            </Button>
                          ) : (
                            <span aria-current="page" className="px-2 font-mono font-semibold">
                              {f === fg.root ? t("flame.all") : f.name}
                            </span>
                          )}
                        </li>
                        {i < crumbs.length - 1 && <li aria-hidden>›</li>}
                      </Fragment>
                    ))}
                    {shown !== fg.root && (
                      <li className="profiling-crumbs-end">
                        <Button size="xs" onClick={() => setZoom(null)}>
                          {t("flame.reset")}
                        </Button>
                      </li>
                    )}
                  </ol>
                </nav>
                <FlameGraphView root={fg.root} zoom={shown} unit={fg.type.unit} onZoom={setZoom} />
              </div>
            )}
          </Panel>
          {fg && fg.total > 0 && (
            <Panel title={t("functions.title")} description={t("functions.description")} flush>
              <FunctionsTable functions={fg.functions} total={fg.total} unit={fg.type.unit} label={t("functions.title")} />
            </Panel>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Compare

function ComparePage({ call }: { call: Call }) {
  const t = useT();
  const [range, setRange] = useState(param("range") ?? "1h");
  const [service, setService] = useState(param("service") ?? "");
  const [type, setType] = useState(param("type") ?? "");
  const [mode, setMode] = useState<"periods" | "label">(param("mode") === "label" ? "label" : "periods");
  const [baseline, setBaseline] = useState<Baseline>((["before", "day", "week"] as const).find((b) => b === param("baseline")) ?? "before");
  const [labelName, setLabelName] = useState(param("labelName") ?? "");
  const [baseValue, setBaseValue] = useState(param("base") ?? "");
  const [headValue, setHeadValue] = useState(param("head") ?? "");
  const [filter, setFilter] = useState(param("label") ?? "");
  const [show, setShow] = useState<"all" | "worse" | "better">("all");
  const head = useMemo(() => periodOf(range), [range]);
  const services = useServices(call, head);
  useEffect(() => {
    if (service || !services?.length) return;
    const first = services.find((s) => s.types.length);
    if (first) (setService(first.name), setType(first.types[0]!.id));
  }, [services, service]);
  useEffect(
    () =>
      keepQuery({
        service,
        type,
        range,
        mode,
        baseline: mode === "periods" ? baseline : undefined,
        labelName,
        base: baseValue,
        head: headValue,
        label: filter,
      }),
    [service, type, range, mode, baseline, labelName, baseValue, headValue, filter],
  );

  const labels =
    useData<{ labels: Record<string, string[]> }>(call, service ? `/api/v1/services/${encodeURIComponent(service)}/labels?${qs(head)}` : null).data?.labels ??
    {};
  const names = Object.keys(labels);
  const name = labelName && names.includes(labelName) ? labelName : (names.find((n) => n === "version") ?? names[0] ?? "");
  const values = labels[name] ?? [];
  const bv = baseValue && values.includes(baseValue) ? baseValue : (values[values.length - 2] ?? values[0] ?? "");
  const hv = headValue && values.includes(headValue) ? headValue : (values[values.length - 1] ?? "");
  const same = mode === "label" && (!bv || bv === hv);
  const base = baselineOf(head, baseline);
  const path =
    !service || !type || same
      ? null
      : mode === "periods"
        ? `/api/v1/compare?${qs({ service, type, ...head, baseFrom: base.from, baseTo: base.to, label: filter ? [filter] : [], baseLabel: filter ? [filter] : [] })}`
        : `/api/v1/compare?${qs({ service, type, ...head, baseFrom: head.from, baseTo: head.to, label: [`${name}=${hv}`], baseLabel: [`${name}=${bv}`] })}`;
  const { data: cmp, error } = useData<Comparison>(call, path);

  const rows = (cmp?.functions ?? []).filter((r) => (show === "all" ? true : show === "worse" ? r.change > 0 : r.change < 0));
  const maxAbs = Math.max(0.0001, ...(cmp?.functions ?? []).map((r) => Math.abs(r.change)));
  const worst = cmp?.functions.filter((r) => r.change > 0).sort((a, b) => b.change - a.change)[0];
  const best = cmp?.functions.filter((r) => r.change < 0).sort((a, b) => a.change - b.change)[0];
  const rate = (p: { total: number; from: string; to: string }) => p.total / Math.max(1, Date.parse(p.to) - Date.parse(p.from));
  const growth = cmp && cmp.base.total > 0 ? ((rate(cmp.head) - rate(cmp.base)) / rate(cmp.base)) * 100 : null;
  const baseName = mode === "label" ? `${name} ${bv}` : t(`comparePage.baseline.${baseline}`);
  const headName = mode === "label" ? `${name} ${hv}` : t("comparePage.thisPeriod");
  const pts = (d: number) => `${d > 0 ? "+" : ""}${d.toFixed(1)}`;

  const columns: Column<FunctionChange>[] = [
    {
      id: "name",
      header: t("functions.function"),
      width: "40%",
      sortValue: (r) => r.name,
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="profiling-swatch" style={{ background: colorOf(r.name) }} />
          <span className="profiling-wrap font-mono text-xs">{r.name}</span>
        </span>
      ),
    },
    {
      id: "base",
      header: t("comparePage.selfIn", { name: baseName }),
      align: "right",
      mono: true,
      sortValue: (r) => r.baseSelf,
      cell: (r) => formatShare(r.baseSelf),
    },
    {
      id: "head",
      header: t("comparePage.selfIn", { name: headName }),
      align: "right",
      mono: true,
      sortValue: (r) => r.headSelf,
      cell: (r) => formatShare(r.headSelf),
    },
    {
      id: "change",
      header: t("comparePage.change"),
      align: "right",
      description: t("comparePage.changeDetail"),
      sortValue: (r) => r.change,
      cell: (r) => (
        <span className={`font-mono text-xs font-semibold ${r.change > 0 ? "text-danger-text" : r.change < 0 ? "text-success" : "text-fg-muted"}`}>
          {t("comparePage.points", { value: pts(r.change) })}
        </span>
      ),
    },
    {
      id: "bar",
      header: t("comparePage.bar"),
      label: t("comparePage.barLabel"),
      width: "180px",
      cell: (r) => {
        const w = (Math.abs(r.change) / maxAbs) * 50;
        return (
          <span aria-hidden className="profiling-diverging">
            <span className="profiling-diverging-axis" />
            <span
              className={r.change > 0 ? "profiling-diverging-up" : "profiling-diverging-down"}
              style={r.change > 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
            />
          </span>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader title={t("comparePage.title")} description={t("comparePage.description")} actions={<TimeRangePicker value={range} onChange={setRange} />} />
      <Panel title={t("comparePage.what")} aria-label={t("comparePage.setup")}>
        <div className="flex flex-col gap-2.5">
          <SegmentedControl
            label={t("comparePage.mode")}
            value={mode}
            onChange={setMode}
            options={[
              { value: "periods", label: t("comparePage.periods") },
              { value: "label", label: t("comparePage.labels") },
            ]}
          />
          <div className="profiling-pickers">
            <ServicePicker
              services={services ?? []}
              service={service}
              type={type}
              onChange={(s, ty) => {
                setService(s);
                setType(ty);
              }}
            />
            {mode === "periods" ? (
              <>
                <SelectField
                  label={t("comparePage.baselineLabel")}
                  value={baseline}
                  onChange={(e) => setBaseline(e.target.value as Baseline)}
                  options={(["before", "day", "week"] as const).map((b) => ({ value: b, label: t(`comparePage.baseline.${b}`) }))}
                />
                <SelectField
                  label={t("pick.label")}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  options={[
                    { value: "", label: t("pick.allProfiles") },
                    ...names.flatMap((k) => (labels[k] ?? []).map((v) => ({ value: `${k}=${v}`, label: `${k} = ${v}` }))),
                  ]}
                />
              </>
            ) : (
              <>
                <SelectField
                  label={t("comparePage.labelName")}
                  value={name}
                  onChange={(e) => (setLabelName(e.target.value), setBaseValue(""), setHeadValue(""))}
                  options={names.length ? names.map((n) => ({ value: n, label: n })) : [{ value: "", label: t("comparePage.noLabels") }]}
                />
                <SelectField
                  label={t("comparePage.baselineLabel")}
                  value={bv}
                  onChange={(e) => setBaseValue(e.target.value)}
                  options={values.map((v) => ({ value: v, label: v }))}
                />
                <span aria-hidden className="profiling-arrow">
                  <ArrowRight className="size-4 text-fg-muted" />
                </span>
                <SelectField
                  label={t("comparePage.comparison")}
                  value={hv}
                  onChange={(e) => setHeadValue(e.target.value)}
                  options={values.map((v) => ({ value: v, label: v }))}
                />
              </>
            )}
          </div>
        </div>
      </Panel>
      {same ? (
        <Panel>
          <EmptyState icon={<GitCompare />} title={t("comparePage.pickTwo")}>
            {names.length ? t("comparePage.pickTwoDetail", { name, value: bv || "–" }) : t("comparePage.noLabelsDetail")}
          </EmptyState>
        </Panel>
      ) : error ? (
        <Callout tone="danger" title={t("comparePage.failed")}>
          {error}
        </Callout>
      ) : !cmp ? (
        <Panel>
          <EmptyState icon={<GitCompare />} title={path ? t("product.loading") : t("flamePage.pick")} />
        </Panel>
      ) : !cmp.base.total || !cmp.head.total ? (
        <Panel>
          <EmptyState icon={<GitCompare />} title={t("comparePage.missing")}>
            {t(cmp.base.total ? "comparePage.missingHead" : "comparePage.missingBase", { name: cmp.base.total ? headName : baseName })}
          </EmptyState>
        </Panel>
      ) : (
        <>
          <KpiGrid>
            <KpiCard
              label={mode === "periods" ? t("comparePage.perSecond") : t("comparePage.totals")}
              value={mode === "periods" && growth !== null ? `${growth > 0 ? "+" : ""}${growth.toFixed(0)}` : formatValue(cmp.type.unit, cmp.head.total)}
              unit={mode === "periods" ? "%" : typeName(t, cmp.type)}
              tone={mode === "periods" && growth !== null && growth > 10 ? "danger" : undefined}
              delta={{ label: `${baseName} ${formatValue(cmp.type.unit, cmp.base.total)} → ${headName} ${formatValue(cmp.type.unit, cmp.head.total)}` }}
            />
            <KpiCard
              label={t("comparePage.worst")}
              value={<span className="profiling-wrap font-mono text-base">{worst?.name ?? "–"}</span>}
              delta={worst ? { label: t("comparePage.points", { value: pts(worst.change) }), intent: "bad" } : undefined}
            />
            <KpiCard
              label={t("comparePage.best")}
              value={<span className="profiling-wrap font-mono text-base">{best?.name ?? "–"}</span>}
              delta={best ? { label: t("comparePage.points", { value: pts(best.change) }), intent: "good" } : undefined}
            />
            <KpiCard
              label={t("comparePage.changed")}
              value={cmp.functions.filter((r) => Math.abs(r.change) >= 0.5).length}
              unit={t("comparePage.changedUnit")}
            />
          </KpiGrid>
          <Panel
            title={t("comparePage.byChange")}
            description={t("comparePage.byChangeDetail", { base: baseName, head: headName })}
            actions={
              <SegmentedControl
                label={t("comparePage.show")}
                value={show}
                onChange={setShow}
                options={[
                  { value: "all", label: t("comparePage.all") },
                  { value: "worse", label: t("comparePage.worse") },
                  { value: "better", label: t("comparePage.better") },
                ]}
              />
            }
            flush
          >
            <DataTable
              label={t("comparePage.table")}
              columns={columns}
              rows={rows}
              getRowId={(r) => r.name}
              defaultSort={{ id: "change", direction: "desc" }}
              minWidth={860}
              empty={<EmptyState title={t("comparePage.noChange")} />}
            />
          </Panel>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Captures and targets

function CaptureDialog({
  call,
  targets,
  open,
  onClose,
  onStarted,
}: {
  call: Call;
  targets: Target[];
  open: boolean;
  onClose: () => void;
  onStarted: () => void;
}) {
  const t = useT();
  const [id, setId] = useState(targets[0]?.id ?? "");
  const target = targets.find((x) => x.id === id);
  const [type, setType] = useState<PullType>(target?.types[0] ?? "cpu");
  const [run, error] = useAction(
    useCallback(() => {
      onStarted();
      onClose();
    }, [onStarted, onClose]),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => call(`/api/v1/targets/${id}/capture`, { method: "POST", body: JSON.stringify({ type }) }));
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("capture.title")}
      description={t("capture.description")}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{t("form.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!target}>
            {t("capture.start")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        {!targets.length ? (
          <p className="m-0 text-sm text-fg-muted">{t("capture.noTargets")}</p>
        ) : (
          <div className="profiling-cols-2">
            <SelectField
              label={t("capture.target")}
              value={id}
              onChange={(e) => {
                setId(e.target.value);
                setType(targets.find((x) => x.id === e.target.value)?.types[0] ?? "cpu");
              }}
              options={targets.map((x) => ({ value: x.id, label: x.service }))}
            />
            <SelectField
              label={t("capture.type")}
              value={type}
              onChange={(e) => setType(e.target.value as PullType)}
              options={(target?.types ?? []).map((x) => ({ value: x, label: t(`pullTypes.${x}`) }))}
            />
          </div>
        )}
        {target?.types.includes("cpu") && type === "cpu" && (
          <p className="m-0 text-xs text-fg-muted">{t("capture.cpuTakes", { seconds: target.cpuSeconds })}</p>
        )}
        <ErrorText message={error} />
      </div>
    </Dialog>
  );
}

function CapturesTable({ captures, loading }: { captures: Capture[]; loading: boolean }) {
  const t = useT();
  const ago = useAgo();
  const columns: Column<Capture>[] = [
    {
      id: "when",
      header: t("captures.when"),
      width: "120px",
      sortValue: (c) => c.startedAt,
      cell: (c) => (
        <span className="whitespace-nowrap text-fg-muted" title={when(c.startedAt)}>
          {ago(c.startedAt)}
        </span>
      ),
    },
    { id: "service", header: t("captures.service"), sortValue: (c) => c.service, cell: (c) => <span className="font-medium">{c.service}</span> },
    { id: "type", header: t("captures.type"), sortValue: (c) => c.type, cell: (c) => <Badge>{t(`pullTypes.${c.type}`)}</Badge> },
    { id: "trigger", header: t("captures.trigger"), cell: (c) => <span className="text-xs">{t(`trigger.${c.trigger}`)}</span> },
    {
      id: "status",
      header: t("captures.status"),
      width: "30%",
      cell: (c) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <CaptureBadge status={c.status} />
          {c.error && (
            <span className="profiling-clamp text-2xs text-danger" title={c.error}>
              {c.error}
            </span>
          )}
        </span>
      ),
    },
    {
      id: "bytes",
      header: t("captures.size"),
      align: "right",
      mono: true,
      sortValue: (c) => c.bytes ?? -1,
      cell: (c) => (c.bytes === null ? "–" : formatBytes(c.bytes, 1)),
    },
    {
      id: "open",
      header: "",
      label: t("captures.open"),
      width: "60px",
      align: "right",
      cell: (c) =>
        c.status === "stored" && (
          <IconButton
            label={t("captures.openOf", { service: c.service })}
            size="sm"
            variant="ghost"
            onClick={() => navigate(`/flame-graph?${qs({ service: c.service })}`)}
          >
            <Flame />
          </IconButton>
        ),
    },
  ];
  return (
    <DataTable
      label={t("captures.title")}
      columns={columns}
      rows={captures}
      loading={loading}
      getRowId={(c) => c.id}
      pageSize={10}
      minWidth={860}
      empty={
        <EmptyState icon={<CircleDot />} title={t("captures.none")}>
          {t("captures.noneDetail")}
        </EmptyState>
      }
    />
  );
}

function ProfilesPage({ call, summary, reload }: { call: Call; summary: Summary; reload: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [range, setRange] = useState(param("range") ?? "1h");
  const [tick, refresh] = useTick(15);
  const [now] = useNow(15);
  const period = useMemo(() => periodOf(range, now), [range, now]);
  const services = useServices(call, period);
  const [capturing, setCapturing] = useState(false);
  const targets = useData<{ targets: Target[] }>(call, "/api/v1/targets", tick).data?.targets ?? [];
  const captures = useData<{ captures: Capture[] }>(call, "/api/v1/captures?limit=100", tick);
  const busy = captures.data?.captures.some((c) => c.status === "capturing");
  // While a capture runs, its row is read again every two seconds.
  useEffect(() => {
    if (!busy) return;
    const id = setTimeout(refresh, 2000);
    return () => clearTimeout(id);
  }, [busy, captures.data, refresh]);
  useEffect(() => keepQuery({ range: range === "1h" ? undefined : range }), [range]);

  const cpu = services?.flatMap((s) => s.types).find((x) => isCpuTime(x));
  const timeline = useData<Timeline>(
    call,
    cpu ? `/api/v1/timeline?${qs({ type: cpu.id, from: Math.floor(period.from / 60_000) * 60_000, to: Math.ceil(period.to / 60_000) * 60_000 })}` : null,
  ).data;
  const chart = useMemo(() => {
    if (!timeline?.series.length) return null;
    const steps = [...new Set(timeline.series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b);
    const per = timeline.stepSeconds * 1e9;
    return {
      labels: steps.map((s) => new Date(s).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })),
      series: timeline.series.slice(0, 20).map((s, i) => {
        const at = new Map(s.points);
        return { id: `s${i}`, name: s.service, data: steps.map((x) => (at.get(x) ?? 0) / per) };
      }),
    };
  }, [timeline]);

  const columns: Column<ServiceInfo>[] = [
    { id: "name", header: t("services.service"), sortValue: (s) => s.name, cell: (s) => <span className="font-medium">{s.name}</span> },
    {
      id: "types",
      header: t("services.types"),
      width: "45%",
      cell: (s) =>
        s.types.length ? (
          <span className="flex flex-wrap gap-1">
            {s.types.map((x) => (
              <Badge key={x.id}>{typeName(t, x)}</Badge>
            ))}
          </span>
        ) : (
          <span className="text-xs text-fg-muted">{t("services.noProfiles")}</span>
        ),
    },
    {
      id: "via",
      header: t("services.via"),
      description: t("services.viaDetail"),
      cell: (s) => <span className="text-xs">{s.targetId ? t("services.pulled") : t("services.pushed")}</span>,
    },
    {
      id: "open",
      header: "",
      label: t("services.open"),
      width: "150px",
      align: "right",
      cell: (s) =>
        s.types.length > 0 && (
          <Button size="sm" icon={<Flame />} onClick={() => navigate(`/flame-graph?${qs({ service: s.name, type: s.types[0]!.id, range })}`)}>
            {t("services.flame")}
          </Button>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t("profilesPage.title")}
        description={t("profilesPage.description", { days: summary.storage.retentionDays })}
        actions={
          <>
            <TimeRangePicker value={range} onChange={setRange} />
            {can("editor") && (
              <Button variant="primary" icon={<CircleDot />} onClick={() => setCapturing(true)}>
                {t("capture.button")}
              </Button>
            )}
          </>
        }
      />
      <KpiGrid>
        <KpiCard label={t("profilesPage.services")} value={services?.filter((s) => s.types.length).length ?? "–"} icon={Layers} />
        <KpiCard
          label={t("profilesPage.targets")}
          value={summary.targets}
          tone={summary.failing.length ? "warning" : undefined}
          delta={summary.failing.length ? { label: t("profilesPage.failing", { count: summary.failing.length }), intent: "bad" } : undefined}
        />
        <KpiCard
          label={t("profilesPage.captures")}
          value={summary.captures.stored}
          delta={summary.captures.failed ? { label: t("profilesPage.capturesFailed", { count: summary.captures.failed }), intent: "bad" } : undefined}
        />
        <KpiCard
          label={t("profilesPage.storage")}
          value={formatBytes(summary.storage.storageBytes, 1)}
          unit={t("profilesPage.storageUnit", { days: summary.storage.retentionDays })}
        />
      </KpiGrid>
      {chart && (
        <Panel title={t("profilesPage.cpu")} description={t("profilesPage.cpuDetail")}>
          <TimeSeriesChart
            label={t("profilesPage.cpu")}
            labels={chart.labels}
            series={chart.series}
            stacked
            area
            height={180}
            xTicks={4}
            format={(v) => t("profilesPage.coresValue", { value: v.toFixed(2) })}
          />
        </Panel>
      )}
      <Panel title={t("services.title")} description={t("services.description")} flush>
        <DataTable
          label={t("services.title")}
          columns={columns}
          rows={services ?? []}
          loading={!services}
          getRowId={(s) => s.name}
          minWidth={760}
          empty={
            <EmptyState icon={<Layers />} title={t("services.none")} action={<Button onClick={() => navigate("/setup")}>{t("flamePage.setup")}</Button>}>
              {t("services.noneDetail")}
            </EmptyState>
          }
        />
      </Panel>
      <Panel title={t("captures.title")} description={t("captures.description")} flush>
        <CapturesTable captures={captures.data?.captures ?? []} loading={!captures.data && !captures.error} />
      </Panel>
      {capturing && (
        <CaptureDialog
          call={call}
          targets={targets}
          open
          onClose={() => setCapturing(false)}
          onStarted={() => {
            refresh();
            reload();
          }}
        />
      )}
    </>
  );
}

const labelsText = (labels: Record<string, string>) =>
  Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
const parseLabels = (text: string) =>
  Object.fromEntries(
    text
      .split(/\n|,/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const at = l.indexOf("=");
        return at < 0 ? [l, ""] : [l.slice(0, at).trim(), l.slice(at + 1).trim()];
      }),
  );

function TargetDialog({ call, target, open, onClose, onSaved }: { call: Call; target?: Target; open: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [service, setService] = useState(target?.service ?? "");
  const [url, setUrl] = useState(target?.url ?? "");
  const [types, setTypes] = useState<PullType[]>(target?.types ?? ["cpu", "heap"]);
  const [scheduled, setScheduled] = useState(target ? target.intervalSeconds !== null : true);
  const [interval, setIntervalSeconds] = useState(String(target?.intervalSeconds ?? 60));
  const [cpuSeconds, setCpuSeconds] = useState(String(target?.cpuSeconds ?? 10));
  const [labels, setLabels] = useState(target ? labelsText(target.labels) : "");
  const [auth, setAuth] = useState<TargetAuth>(target?.auth ?? "none");
  const [username, setUsername] = useState(target?.username ?? "");
  const [secret, setSecret] = useState("");
  const [run, error] = useAction(
    useCallback(() => {
      onSaved();
      onClose();
    }, [onSaved, onClose]),
  );
  const save = (e: FormEvent) => {
    e.preventDefault();
    const body = JSON.stringify({
      service,
      url,
      types,
      intervalSeconds: scheduled ? Number(interval) : null,
      cpuSeconds: Number(cpuSeconds),
      labels: parseLabels(labels),
      auth,
      ...(auth === "basic" && { username }),
      ...(secret && { secret }),
    });
    void run(() => call(target ? `/api/v1/targets/${target.id}` : "/api/v1/targets", { method: target ? "PUT" : "POST", body }));
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={target ? t("targets.edit", { service: target.service }) : t("targets.add")}
      description={t("targets.addDetail")}
      onSubmit={save}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>{t("form.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!service.trim() || !url.trim() || !types.length}>
            {t("form.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <div className="profiling-cols-2">
          <TextField label={t("targets.service")} hint={t("targets.serviceHint")} mono value={service} onChange={(e) => setService(e.target.value)} required />
          <TextField
            label={t("targets.url")}
            hint={t("targets.urlHint")}
            mono
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://10.0.0.5:6060/debug/pprof"
            required
          />
        </div>
        <fieldset className="profiling-fieldset">
          <legend className="text-xs font-medium">{t("targets.types")}</legend>
          <div className="flex flex-wrap gap-3">
            {PULL_TYPES.map((x) => (
              <Checkbox
                key={x}
                label={t(`pullTypes.${x}`)}
                checked={types.includes(x)}
                onChange={(e) => setTypes((all) => (e.target.checked ? [...all, x] : all.filter((y) => y !== x)))}
              />
            ))}
          </div>
        </fieldset>
        <div className="profiling-cols-3">
          <Checkbox label={t("targets.scheduled")} checked={scheduled} onChange={(e) => setScheduled(e.target.checked)} />
          <TextField
            label={t("targets.interval")}
            type="number"
            min={15}
            max={86400}
            disabled={!scheduled}
            value={interval}
            onChange={(e) => setIntervalSeconds(e.target.value)}
          />
          <TextField label={t("targets.cpuSeconds")} type="number" min={1} max={60} value={cpuSeconds} onChange={(e) => setCpuSeconds(e.target.value)} />
        </div>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t("targets.labels")}
          <textarea
            className="profiling-textarea"
            rows={2}
            spellCheck={false}
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
            placeholder="version=v2.14.1"
          />
          <span className="font-normal text-fg-muted">{t("targets.labelsHint")}</span>
        </label>
        <div className="profiling-cols-3">
          <SelectField
            label={t("targets.auth")}
            value={auth}
            onChange={(e) => setAuth(e.target.value as TargetAuth)}
            options={(["none", "bearer", "basic"] as const).map((a) => ({ value: a, label: t(`auth.${a}`) }))}
          />
          {auth === "basic" && <TextField label={t("targets.username")} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />}
          {auth !== "none" && (
            <TextField
              label={auth === "bearer" ? t("targets.token") : t("targets.password")}
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={target?.hasSecret && target.auth === auth ? t("targets.kept") : ""}
            />
          )}
        </div>
        {auth !== "none" && <p className="m-0 text-xs text-fg-muted">{t("targets.sealed")}</p>}
        <ErrorText message={error} />
      </div>
    </Dialog>
  );
}

function TargetsPage({ call, reload }: { call: Call; reload: () => void }) {
  const t = useT();
  const ago = useAgo();
  const { can } = useAuth();
  const [tick, refresh] = useTick(15);
  const { data } = useData<{ targets: Target[] }>(call, "/api/v1/targets", tick);
  const targets = data?.targets;
  const [editing, setEditing] = useState<Target | "new">();
  const [removing, setRemoving] = useState<Target>();
  const [capturing, setCapturing] = useState(false);
  const after = useCallback(() => {
    refresh();
    reload();
  }, [refresh, reload]);
  const [run, error] = useAction(after);
  const columns: Column<Target>[] = [
    { id: "service", header: t("targets.service"), sortValue: (x) => x.service, cell: (x) => <span className="font-medium">{x.service}</span> },
    {
      id: "url",
      header: t("targets.url"),
      width: "28%",
      sortValue: (x) => x.url,
      cell: (x) => (
        <span className="flex min-w-0 flex-col">
          <span className="profiling-wrap font-mono text-xs">{x.url}</span>
          {Object.keys(x.labels).length > 0 && (
            <span className="profiling-clamp font-mono text-2xs text-fg-muted">{labelsText(x.labels).replace(/\n/g, ", ")}</span>
          )}
        </span>
      ),
    },
    {
      id: "types",
      header: t("targets.types"),
      cell: (x) => (
        <span className="flex flex-wrap gap-1">
          {x.types.map((y) => (
            <Badge key={y}>{t(`pullTypes.${y}`)}</Badge>
          ))}
        </span>
      ),
    },
    {
      id: "every",
      header: t("targets.every"),
      align: "right",
      mono: true,
      sortValue: (x) => x.intervalSeconds ?? Infinity,
      cell: (x) => (x.intervalSeconds === null ? t("targets.onDemand") : `${x.intervalSeconds} s`),
    },
    {
      id: "last",
      header: t("targets.last"),
      width: "26%",
      cell: (x) =>
        x.lastCapture ? (
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5">
              <CaptureBadge status={x.lastCapture.status} />
              <span className="text-2xs text-fg-muted">{ago(x.lastCapture.finishedAt ?? x.lastCapture.startedAt)}</span>
            </span>
            {x.lastCapture.error && (
              <span className="profiling-clamp text-2xs text-danger" title={x.lastCapture.error}>
                {x.lastCapture.error}
              </span>
            )}
          </span>
        ) : (
          <span className="text-xs text-fg-muted">{t("targets.never")}</span>
        ),
    },
    ...(can("admin")
      ? [
          {
            id: "actions",
            header: "",
            width: "90px",
            align: "right" as const,
            cell: (x: Target) => (
              <span className="flex justify-end gap-1">
                <IconButton label={t("targets.edit", { service: x.service })} size="sm" variant="ghost" onClick={() => setEditing(x)}>
                  <Pencil />
                </IconButton>
                <IconButton label={t("targets.delete", { service: x.service })} size="sm" variant="ghost" onClick={() => setRemoving(x)}>
                  <Trash2 />
                </IconButton>
              </span>
            ),
          },
        ]
      : []),
  ];
  const failing = (targets ?? []).filter((x) => x.lastCapture?.status === "failed").length;
  return (
    <>
      <PageHeader
        title={t("targets.title")}
        description={t("targets.description")}
        actions={
          <>
            {can("editor") && (
              <Button icon={<CircleDot />} onClick={() => setCapturing(true)} disabled={!targets?.length}>
                {t("capture.button")}
              </Button>
            )}
            {can("admin") && (
              <Button variant="primary" icon={<Plus />} onClick={() => setEditing("new")}>
                {t("targets.add")}
              </Button>
            )}
          </>
        }
      />
      <KpiGrid minWidth={150}>
        <KpiCard label={t("targets.title")} value={targets?.length ?? "–"} icon={Crosshair} />
        <KpiCard label={t("targets.failing")} value={failing} tone={failing ? "danger" : "success"} />
        <KpiCard label={t("targets.scheduledCount")} value={(targets ?? []).filter((x) => x.intervalSeconds !== null).length} />
      </KpiGrid>
      <Panel title={t("targets.title")} flush>
        <DataTable
          label={t("targets.title")}
          columns={columns}
          rows={targets ?? []}
          loading={!targets}
          getRowId={(x) => x.id}
          minWidth={980}
          empty={
            <EmptyState icon={<Crosshair />} title={t("targets.none")}>
              {t("targets.noneDetail")}
            </EmptyState>
          }
        />
      </Panel>
      {editing && <TargetDialog call={call} target={editing === "new" ? undefined : editing} open onClose={() => setEditing(undefined)} onSaved={after} />}
      {capturing && targets && (
        <CaptureDialog call={call} targets={targets} open onClose={() => setCapturing(false)} onStarted={() => setTimeout(after, 1500)} />
      )}
      <Dialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(undefined)}
        title={removing ? t("targets.delete", { service: removing.service }) : ""}
        description={t("targets.deleteDetail")}
        size="sm"
        footer={
          <>
            <Button onClick={() => setRemoving(undefined)}>{t("form.cancel")}</Button>
            <Button
              variant="danger"
              onClick={() => void run(() => call(`/api/v1/targets/${removing!.id}`, { method: "DELETE" })).then((ok) => ok && setRemoving(undefined))}
            >
              {t("form.delete")}
            </Button>
          </>
        }
      >
        <ErrorText message={error} />
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------- Setup

function SetupPage() {
  const t = useT();
  const origin = window.location.origin;
  return (
    <>
      <PageHeader title={t("setupPage.title")} description={t("setupPage.description")} />
      <Panel title={t("setupPage.ebpf")} description={t("setupPage.ebpfDetail")}>
        <Code>{`// Grafana Alloy on each Linux host or Kubernetes node, privileged (it loads an eBPF program)
pyroscope.write "openasy" {
  endpoint {
    url          = "${origin}"
    bearer_token = "<PROFILING_INGEST_TOKEN>"
  }
}

discovery.process "all" { }

discovery.relabel "services" {
  targets = discovery.process.all.targets
  rule {
    source_labels = ["__meta_process_exe"]
    target_label  = "service_name"
  }
}

pyroscope.ebpf "all" {
  targets    = discovery.relabel.services.output
  forward_to = [pyroscope.write.openasy.receiver]
}`}</Code>
      </Panel>
      <Panel title={t("setupPage.sdk")} description={t("setupPage.sdkDetail")}>
        <Code>{`// Go: github.com/grafana/pyroscope-go
pyroscope.Start(pyroscope.Config{
  ApplicationName: "orders-api",
  ServerAddress:   "${origin}",
  AuthToken:       "<PROFILING_INGEST_TOKEN>",
  Tags:            map[string]string{"version": "v2.14.1"},
})`}</Code>
      </Panel>
      <Panel title={t("setupPage.pull")} description={t("setupPage.pullDetail")}>
        <Code>{`// Go: serve pprof on an address only Profiling reaches
import _ "net/http/pprof"
go http.ListenAndServe("10.0.0.5:6060", nil)

// then, under Targets: service orders-api, address http://10.0.0.5:6060/debug/pprof`}</Code>
      </Panel>
      <Panel title={t("setupPage.grafana")} description={t("setupPage.grafanaDetail")}>
        <Code>{`# grafana/provisioning/datasources/openasy-profiling.yaml
apiVersion: 1
datasources:
  - name: OpenAsy Profiling
    type: grafana-pyroscope-datasource
    url: ${origin}
    jsonData: { httpHeaderName1: Authorization }
    secureJsonData: { httpHeaderValue1: "Bearer <API token, viewer role>" }`}</Code>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settingsPage.adminsOnly")}>{t("settingsPage.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`settingsPage.${page}.title`)}
        description={t(`settingsPage.${page}.description`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("settingsPage.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

/** Shown above every page while something needs attention: the storage, the disk, or targets that cannot be read. */
function Attention({ summary, page }: { summary: Summary; page: string }) {
  const t = useT();
  const s = summary.storage;
  if (!s.running)
    return (
      <Callout tone="danger" title={t("attention.storage")}>
        {t("attention.storageDetail")}
      </Callout>
    );
  if (s.freeBytes > 0 && s.freeBytes < 1024 ** 3)
    return (
      <Callout tone="warning" title={t("attention.disk", { free: formatBytes(s.freeBytes) })}>
        {t("attention.diskDetail")}
      </Callout>
    );
  if (summary.failing.length > 0 && page !== "targets")
    return (
      <Callout
        tone="warning"
        title={t("attention.failing", { count: summary.failing.length })}
        action={
          <Button size="sm" onClick={() => navigate("/targets")}>
            {t("attention.see")}
          </Button>
        }
      >
        {summary.failing
          .slice(0, 3)
          .map((f) => `${f.service}: ${f.error}`)
          .join(" · ")}
      </Callout>
    );
  return null;
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const page = parsePage(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "profiling" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => void call<Summary>("/api/v1/summary").then(setSummary, () => {}), [call]);
  useEffect(() => {
    reload();
    const id = setInterval(reload, 15_000);
    return () => clearInterval(id);
  }, [reload]);

  const nav = [
    { id: "profiles", label: msg("product.profiles"), icon: Layers, count: summary?.services || undefined },
    { id: "flame-graph", label: msg("product.flameGraphs"), icon: Flame },
    { id: "compare", label: msg("product.compare"), icon: GitCompare },
    { id: "targets", label: msg("product.targets"), icon: Crosshair, count: summary?.targets || undefined },
    { id: "setup", label: msg("product.setup"), icon: Wrench },
  ];
  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: msg("product.members"), icon: Users },
          { id: "signin", label: msg("product.signIn"), icon: LogIn },
          { id: "tokens", label: msg("product.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("product.account"), icon: UserRound },
  ];
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const settings = page === "account" || page === "members" || page === "signin" || page === "tokens";

  return (
    <AppShell
      product="profiling"
      about={colophon}
      nav={nav}
      activeNav={page}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      setup
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {settings ? (
        <SettingsPage page={page as "account" | "members" | "signin" | "tokens"} />
      ) : !summary ? (
        <EmptyState title={msg("product.loading")} icon={<Flame />}>
          {msg("product.reading")}
        </EmptyState>
      ) : (
        <>
          <Attention summary={summary} page={page} />
          {page === "flame-graph" ? (
            <FlameGraphPage call={call} />
          ) : page === "compare" ? (
            <ComparePage call={call} />
          ) : page === "targets" ? (
            <TargetsPage call={call} reload={reload} />
          ) : page === "setup" ? (
            <SetupPage />
          ) : (
            <ProfilesPage call={call} summary={summary} reload={reload} />
          )}
        </>
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
      <AuthGate product="OpenAsy Profiling">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
