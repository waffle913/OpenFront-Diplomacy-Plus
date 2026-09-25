# Diplomacy+ performance baseline

Scenario: `npm run perf:game`, World map, 400 tribes, 72 nations, seed
`perf-default`, 1,800 measured game ticks. Profiles are written to the ignored
`tests/perf/output` directory.

| Measurement       | Before Lots 1–2 | After Lots 1–2 | Incidents + active AI |
| ----------------- | --------------: | -------------: | --------------------: |
| Throughput        |     134 ticks/s |    126 ticks/s |           134 ticks/s |
| Mean tick         |         7.47 ms |        7.95 ms |               7.47 ms |
| p95               |         15.0 ms |        15.8 ms |               14.7 ms |
| p99               |         22.5 ms |        24.4 ms |               22.8 ms |
| Maximum           |         56.7 ms |        58.5 ms |               64.9 ms |
| Ticks over 100 ms |               0 |              0 |                     0 |
| Peak heap         |          204 MB |         210 MB |                221 MB |

The benchmark contains no diplomatic proposals, so this measures the idle cost
of the registry, proposal transport cache and expanded deterministic hash. The
observed throughput change is -6.0%; repeat runs are required before treating
that difference as a stable regression. The 100 ms tick budget remains intact.

The main allocation source remains `PlayerImpl.toFullUpdate`. The new
`PlayerImpl.hash` accounts for 35.6 MB (0.8%) of sampled game-phase allocation.

The incident/active-AI measurement uses the same map, seed and 1,800 game
ticks, with CPU and allocation profile writing disabled to avoid profiler
overhead. Only the 72 full nations run Diplomacy+; the 400 temporary tribes do
not enter the registry or its initiative scans. Active diplomacy adds no tick
over the 100 ms budget. The higher peak heap warrants watching in longer runs,
although incident history is bounded and empty in this benchmark scenario.
