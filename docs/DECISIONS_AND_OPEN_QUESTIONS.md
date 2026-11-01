# Decisions and unresolved checks

Date: 1 November 2026, IST. This file separates user direction, proposed implementation choices, and unverified assumptions.

## Confirmed user direction

| Decision | Basis |
| --- | --- |
| Participate in DotRepo's CodeQuest and focus first on Idea Submission | User supplied the official listing and required-slide screenshot. |
| Build the proposal around permissions, shared budgets, and verified completion | User accepted the project direction after the comparison and requested a detailed plan and PPT. |
| No $5 E2B verification payment or other new purchases | User explicitly cannot pay; the account screenshot establishes the baseline restriction. |
| Use local execution as the replacement | User accepted the explanation of local desktops and their differences from cloud instances. |
| Available model providers are NVIDIA and potentially Fireworks | User offered those API keys, but no key has been provided or tested. |
| Team name is Team Update; presenter is Shikhar | Explicit user reply during deck preparation. |
| Choose a catchy project name | Explicit user delegation. TaskLatch is the chosen proposal name. No domain or trademark clearance is claimed. |
| Store an elaborate plan in the project, then create the PPT | Current task. Prototype implementation and final submission are later work. |

## Proposed design choices

- Two local Linux desktop containers inside one Colima VM, using native arm64 images.
- A single local operator, Node/TypeScript controller, React UI, SQLite, and local artifacts.
- SupplierLab, a synthetic supplier-comparison and purchase-request application, as the first supported workflow.
- Direct NVIDIA model requests through the trusted controller. Fireworks disabled in zero-cash mode.
- Backend-owned consequential actions and read-only guest access to the protected application.
- Exact payload approval, transactional budget reservations, and independent completion checks.
- A 10-slide deck with all official required topics. Numerical internal evaluation targets are engineering targets, not official judging weights.
- Independently implement the prototype while verifying the license before copying any Opticon source.

These choices may be revised after the capability spikes, while preserving the user-approved no-payment and honest-claims boundaries.

## Open checks and resolutions required

| ID | Check | Needed before | Resolution evidence |
| --- | --- | --- | --- |
| O-01 | NVIDIA key authenticates and can use the selected image-capable model | Live agent loop | Small successful text, image, and action-schema probe with served model recorded |
| O-02 | Rate limits, latency, and usage metadata are suitable for two workers | Final runtime choice | Bounded concurrent test and measured responses, not assumed catalog limits |
| O-03 | Colima boots with host home sharing disabled | Any worker execution | Reviewed config, mount inventory, and negative access checks |
| O-04 | Lean desktop image works on arm64 within available resources | Two-worker milestone | Startup, CPU/RAM/disk observations, screenshots, and browser navigation |
| O-05 | Broker-only write authority resists browser and direct HTTP bypass | Security demo | Negative fixture writes and resource-side logs |
| O-06 | Current NVIDIA free endpoint trial terms fit the intended demo | Public demonstration | Rechecked official documentation; no implication of production entitlement |
| O-07 | Opticon licensing and notices if any code is reused | Source reuse | License file/permission and required attribution, otherwise independent implementation |
| O-08 | NVIDIA OpenShell/NemoClaw integration relevance | Strong novelty claims | Policy overlap confirmed in primary docs; compare actual covered workflow and integration effort |
| O-09 | New organizer judging weights or instructions | Final submission | Official listing and registered-participant instructions; avoid invented weights |
| O-10 | Export and rendering in the target presentation application | Final upload | Visual check and file-open verification where available |

## Corrections preserved

The earlier assumption that E2B's publicly advertised credits were usable without any payment was incorrect for this user's workspace. The actual account gate takes precedence. The project excludes E2B from the zero-cash baseline.

The original Opticon already has plan approval, stop controls, and recovery paths. Our proposal adds or strengthens exact runtime authorization, common budget accounting, verified outcomes, and local execution. It does not claim those existing features were absent.

A free API response does not verify vision, tool calling, reliability, or authorization. A completed agent loop does not verify a business outcome. These distinctions remain release gates.
