# v1.3 Task 10: owner decision (2026-11-06)

**Count usage-store failures that never reach `emitTrace` (Review Focus 2).** Since v1.3 Task 7 (PR #69), the usage
store catches its own failures. A dropped batch happens in `flush()` on a 250 ms timer, and a failed retention
pass happens in `startRetention`'s interval. A store that can't be opened makes `getUsageStore()` disable itself.
None of these throw into `emitTrace`, so the counter Task 10 adds there would miss them. Review Focus 2 requires
`babelgate_sink_errors_total{sink="usage-store"}` to count them.

- Do: export one function from `src/observe/emit.ts` that the counter uses for both paths, e.g.
  `reportSinkError(sink: string): void`. `emitTrace`'s own catch calls it too. Call it with `"usage-store"` in
  three places: the batch-dropped catch in `src/observe/sinks/usage-store.ts` `flush()`, the catch in
  `src/observe/retention.ts`, and the disable path in `getUsageStore()`. Count every failure, even when the
  warning is throttled. The store must not import `metrics.ts` or `prom-client`; it calls only into `emit.ts`.
  With `METRICS=off` the call is a no-op.
- Test, in `tests/integration/observe.test.ts`, named `"usage-store failures count"`: make one flush fail (BEGIN
  already open on the store's connection, as in Task 7's `"flush never throws"`), flush, and assert `GET /metrics`
  contains `babelgate_sink_errors_total{sink="usage-store"} 1`.
- `usage-store.ts` and `retention.ts` are outside Task 10's Files block. List them under "Files outside the Files block"
  in the Task 10 decisions entry.
