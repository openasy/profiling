# profiling

[![CI](https://github.com/openasy/profiling/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/profiling/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Profiling product: **which lines of code use the CPU and memory, all the
time, in production** (ADR 0068). Profiling keeps the profiles that Grafana Alloy's eBPF profiler and the Pyroscope
SDKs push, and the pprof it reads itself from the services you add as pull targets, in Grafana Pyroscope inside its
one container. It shows them as flame graphs per service and over time, and compares two periods, or two versions in
the same period, to show which functions grew and which shrank.

```
Grafana Alloy (pyroscope.ebpf, every process) ──push──┐
Pyroscope SDKs (Go, Java, Python, ...) ────────push───┼──▶  profiling  ──▶ Pyroscope (127.0.0.1, /data)
services with net/http/pprof ◀──────────read─────────┘        │
                                                              ├──▶ profiles, flame graphs, compare, targets
                                                              └──▶ /querier.v1.QuerierService: Grafana
```

## How profiles arrive

- **eBPF, with no change to the code.** Grafana Alloy's `pyroscope.ebpf` samples every process on a Linux host or
  Kubernetes node and sends through `pyroscope.write` with the address `https://profiling.example.com`; it posts to
  `/push.v1.PusherService/Push`, Pyroscope's own push API. Alloy runs privileged and needs a recent Linux kernel.
  `pyroscope.java` and `pyroscope.scrape` send the same way.
- **Pyroscope SDKs** for Go, Java, Python, Ruby, .NET, Node.js and Rust send to `/ingest` with
  `ServerAddress: https://profiling.example.com`, with heap, lock and goroutine profiles and labels of your own, such
  as `version`.
- **Pull targets** you add under Targets: a service that serves pprof over HTTP, such as Go's `net/http/pprof`, read on
  a schedule (every 60 seconds by default) or only when someone captures a profile now. Each type is read at its path
  under the address: `/profile?seconds=N` for CPU, `/heap`, `/goroutine`, `/mutex` and `/block`. Labels you set (such
  as `version=v2.14.1`) are added to every profile read. A bearer token or a user and password is sealed with
  `openasy-kek` (ADR 0021) and never shown again; a redirect is refused, so the sign-in is never sent to another
  address. Every read is kept as a capture, with whether it was stored and why not.

Pushing needs `PROFILING_INGEST_TOKEN`, which can push and nothing else, or an API token with the editor role.

```alloy
pyroscope.write "openasy" {
  endpoint {
    url          = "https://profiling.example.com"
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
}
```

## Reading it

- **Profiles**: every service with profiles in the range and its types, CPU by service in cores over time, the pull
  targets that cannot be read, and the captures.
- **Flame graphs**: one service and type over a range, filtered by a label such as `version`, merged into one flame
  graph. Width is the share of the whole; hover a frame for its numbers and click to zoom in. Under it, the functions
  with the most self time, wherever they are called from.
- **Compare**: the period before (or the same period a day or a week before), or two values of a label in the same
  period. Shares of the whole are compared, not raw values, so a busier period does not make every function look
  slower. Functions are listed by how many percentage points their self share moved.
- **Grafana** reads Profiling with its Pyroscope data source: URL `https://profiling.example.com`, with an API token of
  the viewer role sent as `Authorization: Bearer`. Only Pyroscope's query methods are passed on (ProfileTypes,
  LabelNames, LabelValues, Series, SelectMergeStacktraces, SelectMergeSpanProfile, SelectMergeProfile, SelectSeries,
  Diff, GetProfileStats); its other services and its own UI are not reachable.

## Run

```bash
openssl rand -hex 32 > openasy-kek
export PROFILING_INGEST_TOKEN=$(openssl rand -hex 32)   # only if something pushes
docker compose up -d
docker compose logs profiling | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and API
are on http://localhost:8080, the API reference at http://localhost:8080/api/docs/.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `PROFILING_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `OPENASY_PRODUCTS` | | The install's OpenAsy products, for the product switcher |
| `PROFILING_INGEST_TOKEN` | | Lets Alloy and the SDKs push profiles and nothing else. An API token with the editor role works too |
| `PROFILING_RETENTION_DAYS` | `14` | How long profiles and captures are kept |
| `PROFILING_INGEST_MB_PER_SECOND` | `8` | Pushed profile data taken per second once unpacked, with bursts of four seconds' worth; above it pushes get 429 |
| `PROFILING_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `PROFILING_DATA` | `/data` | SQLite file and Pyroscope's storage, on the `/data` volume |
| `PROFILING_STORAGE_PORT`, `PROFILING_STORAGE_GRPC_PORT`, `PROFILING_STORAGE_RAFT_PORT` | `4040`, `9095`, `9099` | Pyroscope's ports, on 127.0.0.1 inside the container |
| `PROFILING_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `PROFILING_HEADLESS` | `false` | `true` serves only the API |
| `PROFILING_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

Pyroscope runs as one node: its rings are kept in memory, so it opens no gossip port, and every port it opens is on
127.0.0.1. Its usage statistics and its profiling of itself are off, so nothing leaves the container. `/metrics` has
`openasy_profiling_storage_up`, `openasy_profiling_services`, `openasy_profiling_targets_failing`,
`openasy_profiling_captures_total{result}`, `openasy_profiling_pushed_bytes_total{via}` and the disk used and free.
Watch `openasy_profiling_storage_up` from a system other than Profiling.

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`.

## Roles

Viewers see every profile, Grafana's token included; editors also capture profiles now and push them; admins also add,
change and delete pull targets, which may hold passwords, and manage members and API tokens (ADR 0003). Anyone with the
viewer role sees the function names and labels of every service.

## Not yet

Profiling's own eBPF agent and an install page for Alloy on Kubernetes, the Services screen with agent versions and
per-service switches for profile types and sampling rate, captures that start on a CPU spike, links from a slow span in
Traces to the profile of that moment and from a CPU graph in Metrics, a diff flame graph drawn in two colours, saved
and shared comparisons, pull targets from the install's hosts file (ADR 0052), and a size limit for the disk are
planned.

## Develop

```bash
npm install
npm test        # fetches the pinned Pyroscope into vendor/, then pushes, pulls and queries it for real, and checks every API response against openapi.json
npm run dev     # the UI, with the API on :8080
node scripts/openapi.ts   # after changing the API
```

## Licence

AGPL-3.0 (ADR 0008).
