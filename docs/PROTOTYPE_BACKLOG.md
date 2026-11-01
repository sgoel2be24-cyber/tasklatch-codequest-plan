# Prototype backlog and dependency order

All items are unimplemented as of 1 November 2026. No success marks below imply tests have run. Dates and acceptance targets are planning assumptions. Keep the three headline features fixed.

| ID | Work package | Depends on | Done means | Priority |
| --- | --- | --- | --- | --- |
| B01 | Runtime/model capability report | None | NVIDIA text/image/action probe, usage metadata, rate-limit observations; safe local VM config and two browser screenshots | P0 |
| B02 | SupplierLab and authoritative fixture state | None | Synthetic vendors, versioned source records, restricted submit endpoint, independent receipt read | P0 |
| B03 | Schemas and session state machine | None | Valid/invalid plans, typed actions, explicit task outcomes and stable error codes | P0 |
| B04 | Local operator auth and ownership | B03 | HTTP, WebSocket, replay and artifact endpoints refuse unauthorized cross-session access | P0 |
| B05 | One-worker end-to-end execution | B01–B04 | Research a source and save a candidate artifact without privileged credentials in the guest | P0 |
| B06 | Second worker and structured findings | B05 | Independent research outputs preserve source versions; merge does not elevate instructions | P0 |
| B07 | External policy broker | B02–B06 | Allowed reads proceed; unknown actions and direct write attempts fail at the resource boundary | P0 |
| B08 | Exact approval workflow | B07 | Approval binds current payload, policy and resource version; changed/replayed/expired requests fail | P0 |
| B09 | Reservation ledger and global limits | B03, B05 | Two workers cannot reserve the same remaining allocation; coordinator and retries count | P0 |
| B10 | Independent stop path | B07–B09 | New actions blocked on stop state; leases and approvals revoked; process/container exit independently confirmed | P0 |
| B11 | Result verifier | B02, B03, B08 | Artifact and receipt checks separate success, error, unknown and partial outcome | P0 |
| B12 | Evidence and private replay | B04, B09–B11 | Export action/approval/budget/result lineage; enforce access and retention; no keys in bundle | P0 |
| B13 | Deterministic boundary suite | B07–B12 | Catalog cases execute with state assertions and no invented dashboard success | P0 |
| B14 | Model-backed baseline comparison | B13 | Same seeded task set in baseline and controlled mode; publish useful success plus safety/error outcomes | P0 |
| B15 | Clean setup and recorded demo | B14 | README install/start/run/stop path, actual demo video, benchmark manifest, limitation disclosures | P0 |
| B16 | Four agents | Measured two-agent stability | Resource and utility evidence justifies it | Deferred |
| B17 | Cloud runtime adapter | B15 | Provider funding and equivalent enforcement evaluated | Deferred |
| B18 | Additional business integrations | B15 | Each has defined authorization, idempotency and verification semantics | Deferred |

## Suggested repository shape when implementation starts

```text
apps/web/                 UI, desktop view, approval review, result viewer
apps/controller/          authentication, policy, actions, budgets, events
packages/contracts/       shared schema and state definitions
packages/runtime-local/   trusted VM/container lifecycle adapter
packages/model-client/    direct provider adapter and central rate limiter
packages/verifiers/       deterministic artifact and receipt checks
fixtures/supplierlab/     controlled source pages and test request service
tests/contracts/          schema/state/policy tests
tests/e2e/                real controller, fixture app, browser flow
tests/evaluation/         seeded scenarios and result reporting
docs/                     source-backed plan and runbooks
.runtime/                 ignored local data and ephemeral credentials
```

This is a proposed structure, not a scaffold that already exists. Start with the smallest folders needed for B01–B05 rather than creating empty abstractions.

## Scope reduction order

If necessary, reduce visual replay quality, optional report formatting, the number of vendors, or planner sophistication. Preserve action authority, truthful status, budget reservations, and evidence. If two workers cannot run, report one-worker limitations instead of showing prerecorded concurrency as live execution. Do not replace a failed model loop with a scripted demo without clear labelling.

## Model and runtime decision record

Store capability results with date, endpoint/model ID, test input hash, exact observed output, latency, usage fields and failures. Redact credentials. Record container image digests, arm64 support, exposed ports, host mounts and effective privilege. Keep any commands reproducible in the setup documentation after they have actually succeeded.
