// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export interface ProfileType {
  id: string;
  name: string;
  sampleType: string;
  unit: string;
}

export interface ServiceInfo {
  name: string;
  types: ProfileType[];
  targetId: string | null;
}

export interface Frame {
  name: string;
  total: number;
  self: number;
  children: Frame[];
}

export interface FunctionStat {
  name: string;
  self: number;
  total: number;
}

export interface FlameGraph {
  type: ProfileType;
  from: string;
  to: string;
  total: number;
  root: Frame;
  functions: FunctionStat[];
}

export interface FunctionChange {
  name: string;
  baseSelf: number;
  headSelf: number;
  baseTotal: number;
  headTotal: number;
  change: number;
}

export interface ComparedPeriod {
  from: string;
  to: string;
  labels: Record<string, string>;
  total: number;
}

export interface Comparison {
  type: ProfileType;
  base: ComparedPeriod;
  head: ComparedPeriod;
  functions: FunctionChange[];
}

export interface Timeline {
  type: ProfileType;
  stepSeconds: number;
  series: Array<{ service: string; points: Array<[number, number]> }>;
}

export type PullType = "cpu" | "heap" | "goroutine" | "mutex" | "block";
export const PULL_TYPES: PullType[] = ["cpu", "heap", "goroutine", "mutex", "block"];
export type TargetAuth = "none" | "bearer" | "basic";

export interface Capture {
  id: string;
  targetId: string | null;
  service: string;
  type: PullType;
  trigger: "schedule" | "manual";
  status: "capturing" | "stored" | "failed";
  error: string | null;
  bytes: number | null;
  startedAt: string;
  finishedAt: string | null;
  createdBy: string;
}

export interface Target {
  id: string;
  service: string;
  url: string;
  types: PullType[];
  intervalSeconds: number | null;
  cpuSeconds: number;
  labels: Record<string, string>;
  auth: TargetAuth;
  username: string | null;
  hasSecret: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastCapture: Capture | null;
}

export interface Summary {
  storage: { running: boolean; storageBytes: number; freeBytes: number; retentionDays: number };
  services: number;
  targets: number;
  captures: { stored: number; failed: number };
  failing: Array<{ targetId: string; service: string; type: PullType; error: string; at: string }>;
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
