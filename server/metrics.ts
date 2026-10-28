// Prometheus text exposition, written by hand: a few lines, no client library needed.
import type { Summary } from "./service.ts";

const requests = new Map<string, number>();
const pushed = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

/** Bytes of profiles pushed in and taken, by the way they came. */
export function countPushed(via: "alloy" | "ingest", bytes: number) {
  pushed.set(via, (pushed.get(via) ?? 0) + bytes);
}

export function renderMetrics(version: string, s: Summary, captures: { stored: number; failed: number }): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="profiling",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_profiling_storage_up 1 while Pyroscope, which keeps the profiles, answers. Watch this from another system.",
    "# TYPE openasy_profiling_storage_up gauge",
    `openasy_profiling_storage_up ${s.storage.running ? 1 : 0}`,
    "# HELP openasy_profiling_services Services with profiles in the last hour.",
    "# TYPE openasy_profiling_services gauge",
    `openasy_profiling_services ${s.services}`,
    "# HELP openasy_profiling_targets Pull targets people added.",
    "# TYPE openasy_profiling_targets gauge",
    `openasy_profiling_targets ${s.targets}`,
    "# HELP openasy_profiling_targets_failing Pull targets whose last capture failed.",
    "# TYPE openasy_profiling_targets_failing gauge",
    `openasy_profiling_targets_failing ${s.failing.length}`,
    "# HELP openasy_profiling_captures_total Profiles read from pull targets since Profiling started, by result.",
    "# TYPE openasy_profiling_captures_total counter",
    `openasy_profiling_captures_total{result="stored"} ${captures.stored}`,
    `openasy_profiling_captures_total{result="failed"} ${captures.failed}`,
    "# HELP openasy_profiling_pushed_bytes_total Bytes of profiles pushed in and taken by Pyroscope, by the way they came.",
    "# TYPE openasy_profiling_pushed_bytes_total counter",
    ...(["alloy", "ingest"] as const).map((v) => `openasy_profiling_pushed_bytes_total{via="${v}"} ${pushed.get(v) ?? 0}`),
    "# HELP openasy_profiling_storage_bytes Disk taken by the profiles.",
    "# TYPE openasy_profiling_storage_bytes gauge",
    `openasy_profiling_storage_bytes ${s.storage.storageBytes}`,
    "# HELP openasy_profiling_storage_free_bytes Free space on the data volume.",
    "# TYPE openasy_profiling_storage_free_bytes gauge",
    `openasy_profiling_storage_free_bytes ${s.storage.freeBytes}`,
    "# HELP openasy_profiling_retention_days How long profiles are kept.",
    "# TYPE openasy_profiling_retention_days gauge",
    `openasy_profiling_retention_days ${s.storage.retentionDays}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
