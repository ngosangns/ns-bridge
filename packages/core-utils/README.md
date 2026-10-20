# ns-core-utils

> Development of this package has stopped. The maintained package is [@ngosangns/ns-bridge](https://www.npmjs.com/package/@ngosangns/ns-bridge).

Plumbing every vendor core in [ns-bridge](https://github.com/ngosangns/ns-bridge)
needs and none of them owns. It has no dependencies and no host types, so a core
can depend on it without gaining a host coupling.

- **Retry headers** — `parseRetryAfterMs` reads `retry-after-ms`, numeric and
  HTTP-date `retry-after`, and `x-ratelimit-reset-after`, taking either a
  `Headers` or a plain record. One parser, so a vendor cannot silently miss a
  header another vendor honors.
- **Backoff** — `exponentialBackoff(attempt, baseMs, maxMs)`.
- **Timing** — `abortableDelay(ms, signal)` rejects the moment the caller aborts.
- **Cache** — `readJsonFile` and `writeJsonFileAtomic`, which renames a temp file
  over the target so a crash mid-write cannot leave a torn catalog.

This package is not meant to be installed on its own. It is a dependency of
`ns-kiro-core` and `ns-devin-core`.
