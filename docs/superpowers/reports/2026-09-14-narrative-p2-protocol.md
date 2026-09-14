# Narrative P2 Protocol

## Frozen contract

P2 protocol version is `narrative-p2/v1`. The executable entry is
`npm run journey:narrative:p2`; `register` writes a hash-bound protocol with
S-short and M-medium routes, and `replay` reads only the protocol and route
artifacts. Register does not create narrative text or call a provider. The
protocol fixes the 50/10 summary policy, per-epoch summary budgets, and input
estimate limits.

The application contract is
`runNarrativeP2Journey({ mode, runId, protocolPath, outputDirectory })`.
Script argument parsing also accepts `--replay-source`. Live execution remains
explicitly gated by `RUN_REAL_AI_JOURNEY=1` and must be run only after the
production route executor and provider configuration are frozen.

## Verification

- `narrativeP2Journey.test.ts` covers two-route registration and zero-network
  replay with missing artifacts.
- `narrativeP2Journey.node-test.mjs` covers CLI parsing, protocol hashing and
  replay of two completed route artifacts.
- Full Vitest regression: 228 files passed, 1 skipped, 2882 tests passed, 1
  skipped.

This report records the protocol and offline/replay contract only. It is not a
live AI quality or complete-story acceptance report; those require a separate
frozen run with real provider credentials and captured transport artifacts.
