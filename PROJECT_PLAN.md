# TaskLatch: detailed project plan

**Version:** 1.0  
**Date:** 1 November 2026, IST  
**Team:** Team Update  
**Presenter:** Shikhar  
**Stage:** idea proposal, before implementation  
**Evidence:** [source register](docs/EVIDENCE_REGISTER.md)  
**Validation contract:** [evaluation plan](docs/EVALUATION_PLAN.md)

## 1. Product position and decision boundaries

TaskLatch gives a small team a way to delegate a bounded browser task to two local agents while controlling consequential actions and checking the result. The first user is an operations generalist in a small business or student organization who needs a supplier comparison and a purchase request. The user should be able to let research proceed while reviewing the exact proposed external change before it happens.

The first product is a controlled prototype, not a general-purpose autonomous purchasing system. Its visible desktop experience comes from local Linux environments. The original contribution is a control path that remains outside the model: permissions, action-specific authorization, shared resource accounting, and independent result verification.

The task accepted by the user is to build the project around three core additions. Supporting authentication, reliable shutdown, data retention, and a reproducible test application are necessary foundations. They are not additional headline features. No payment, premium cloud service, card verification, or new paid model subscription is an implementation dependency.

The following are confirmed user decisions: pursue this project direction, use local execution rather than E2B, retain the three controls, create the plan and PPT in this project, use Team Update and presenter Shikhar, and allow a new project name. The name TaskLatch, exact workflow, schemas, numerical test targets, and stack details below are Codex's proposed implementation choices. They are not claims of completed work or user validation.

## 2. The specific user problem

An operations user can delegate research but cannot continuously supervise multiple desktop agents. A useful task may mix safe reading, local drafting, and a consequential submission. A broad prompt such as "find suitable suppliers and prepare the order" leaves several unresolved questions: which sources may the agent access, whether a quoted price is verified, whether a purchase is authorized, and whether a finished session actually produced a valid request.

The failure is often an authority mismatch. An agent with an authenticated session can technically perform an action even when that action was not what the user intended. A separate computer reduces exposure of the user's host but does not establish business authority. A transcript or screen recording helps investigation but does not itself prevent an action or prove successful delivery.

Evidence establishes that this broader category exists. The register distinguishes a documented Replit database incident, survey reports, vendor capabilities, a viral unverified spending story, and our own architectural inferences. The $2,997 Clawdbot story is excluded from headline proof. Survey percentages must retain their sample, reporting period, funding, and denominator. No incident-per-agent-action rate or reliable average agent-loss dollar figure has been established.

## 3. First workflow: supplier research and purchase-request preparation

### 3.1 Canonical task

"Compare two office-supply vendors for 20 USB-C adapters. Use the approved supplier pages, capture price and stock evidence, and prepare a purchase request for review. Do not place an order."

The domain is a demonstration setting, not a claim that procurement is uniquely underserved. It provides legible success criteria and allows genuine state changes against synthetic records without money, email delivery, or a production account.

### 3.2 Actors and resources

- The human requester owns a session and approves its initial scope.
- Worker A researches vendor A in its own disposable desktop container.
- Worker B researches vendor B in another desktop container.
- A coordinator plans two independent subtasks and merges structured findings. It cannot approve actions or issue capabilities.
- SupplierLab is a local test application with synthetic vendor pages, a request database, read endpoints, and a restricted submission endpoint.
- The action broker owns the credential or local capability needed to submit a purchase request.
- The verifier reads saved artifacts and SupplierLab state independently of the agent's narrative.

The laptop operator is trusted to administer the local host. Workers and model outputs are not trusted administrators. A model prompt is never an access-control mechanism.

### 3.3 Main interaction

1. The user enters the task and chooses the Research and Draft preset.
2. The scope screen shows allowed resources, exact allowed write location, maximum workers, time/action/token limits, and which operations require approval.
3. The coordinator returns a schema-validated plan. The user may edit it before starting.
4. The controller starts two desktops and issues separate, short-lived worker identities.
5. Workers browse permitted SupplierLab pages and extract structured findings with source IDs. The UI displays activity and screenshots.
6. Each worker saves a candidate result. The coordinator creates a comparison artifact and a purchase-request draft.
7. A requested submission reaches the broker. The broker displays the exact vendor, quantity, unit price, total, and destination. The agent has no submission credential.
8. Approval creates a single-use authorization for that exact payload and current policy version. Denial, timeout, cancellation, or changed details prevent execution.
9. The broker performs the authorized test operation with an idempotency key. The verifier checks the resulting record and artifact.
10. The session completes only when its required deliverables pass. The user receives an evidence bundle and a truthful outcome.

### 3.4 Required deliverables

A machine-readable comparison JSON and a readable comparison document must contain vendor identifiers, item identifier, quantity, currency, unit price, stock status, source URLs or fixture IDs, capture times, and missing-data flags. A request draft must reference the comparison artifact and its content hash. An approved test submission must include a matching receipt ID verified in SupplierLab. Missing stock or conflicting prices require an unresolved warning, not an invented value.

## 4. Scope for the first version

| In the first version | Explicitly outside the first version |
| --- | --- |
| Two workers, one operator, local execution | Public multi-tenant SaaS or continuously available cloud service |
| Linux browser desktops with observation/action streaming | Arbitrary control of the user's macOS desktop |
| Read approved sources and write disposable artifacts | Personal browser profiles, password vaults, production database access |
| Exact approval for one supported submission action | Real card payments, banking, autonomous purchasing, external email delivery |
| One shared resource ledger | Guaranteed accounting for unknown provider-side billing behavior |
| Deterministic checks against known deliverables | Universal judgment of arbitrary document quality |
| Synthetic business data with real local state transitions | Claims of real financial savings, customer traction, enterprise compliance |

Four workers, additional integrations, cloud execution, full OS automation, and automatic replanning are possible later extensions. They must not delay the three core controls or appear as delivered capabilities in the idea deck.

## 5. Architecture and trust boundaries

```text
Human browser
  | authenticated local UI and session ownership
Controller + policy engine + action broker
  |                 |                  |
SQLite ledger    Artifact store     NVIDIA inference adapter
  |
Dedicated Linux VM managed through Colima
  |-- worker A container: desktop, browser, disposable files
  |-- worker B container: desktop, browser, disposable files
  |-- controlled network path to permitted sources and broker

SupplierLab restricted write path: broker only
Verification path: independent read of saved artifacts and SupplierLab state
```

The source repository currently contains planning artifacts, not this runtime. The diagram is a proposed architecture. The local VM separates Linux execution from macOS. The worker containers share the guest Linux kernel, so they are not equivalent to E2B microVM-per-agent isolation. Local execution depends on laptop uptime and resources.

The controller retains provider keys and tool credentials. Do not inject them into worker environments. The worker sends an observation and action proposal through a narrow controller protocol. It does not receive arbitrary Docker control or permission to spawn new containers. The trusted host adapter validates every lifecycle operation.

The first implementation must disable automatic sharing of the user's home folder. Expose only dedicated disposable task volumes. Do not mount the Docker socket, SSH agent, keychain, browser profile, or host root. Do not run privileged workers or grant host networking. Review Colima defaults before startup because an installed runtime is not evidence of a safe configuration.

The Linux guest and worker images must support arm64. Prefer native images. Do not rely on x86 emulation for the critical demo path. Allocate conservatively, starting with two workers and approximately 1.5–2 GiB per desktop if measurements support it. This is a resource hypothesis, not a tested guarantee. The observed laptop had 16 GB RAM and about 35 GiB free during the earlier check; recheck before downloading images. Use a bounded VM disk and do not copy model weights locally.

## 6. Proposed stack and why it is limited

| Layer | Proposed choice | Reason and implementation boundary |
| --- | --- | --- |
| UI | React, TypeScript, Vite | A separate Node controller owns long-lived connections and workers. This avoids making serverless hosting a prerequisite. |
| Controller | Node.js/TypeScript, HTTP API, WebSocket | One language for schemas, policies, queue, and UI contracts. No distributed scheduler for two workers. |
| Runtime | Colima Linux VM with Docker containers | Existing installed tools, no provider payment gate. Requires measured startup and hardening checks. |
| Browser | Chromium + Playwright | Read DOM/accessibility where supported and use screenshots for context. Do not force every operation through pixels. |
| Desktop transport | Xvfb, a lightweight window manager, x11vnc/noVNC where required | Provides a real desktop view. This is an integration spike, not a proven image yet. |
| Model | Direct NVIDIA hosted API, candidate Nemotron 3 Nano Omni | Public docs expose image input and a free prototype endpoint. Validate the user's key, tool format, and latency before selecting the final model. |
| Validation | Zod or JSON Schema | Reject malformed plans, actions, and results outside the model. |
| Persistence | SQLite with transactional writes | Enough for one local controller. Use integer counters and atomic reservations. |
| Artifacts | Private local files plus content hashes | No paid object storage. File names and paths are generated by the controller. |
| Tests | Vitest, Playwright, controlled fixture services | Contract tests and end-to-end scenarios with externally checked state. |

No Dedalus, E2B, Neon, Flowglad, paid authorization platform, GPU rental, or production Google account is required. Existing Opticon architecture informs the interaction pattern, but this stack is an intentional local implementation rather than a claim of unchanged Opticon compatibility.

## 7. Core control A: external permissions and exact approvals

### 7.1 Action envelope

Every proposal contains session_id, worker_id, task_id, action_id, action_type, resource_id, payload, expected_resource_version, policy_version, and a correlation ID. The controller binds identities from the authenticated connection rather than trusting identity strings supplied by the model. Unknown fields or types fail validation where the schema is strict.

Use typed actions such as source.read, artifact.write_candidate, artifact.publish_local, request.prepare, and request.submit. Low-level click/type/scroll proposals are allowed only inside the approved browser workspace. A generic terminal or unrestricted HTTP client must not become an alternative path to the protected service. GUI activity cannot be promoted into a universal semantic safety guarantee.

The policy result is ALLOW, REQUIRE_APPROVAL, or DENY with a stable reason code. Deny is the default for unknown resources, unavailable policy state, malformed inputs, expired identities, forbidden destinations, or ownership mismatch. Permission checks occur before side effects. The coordinator and workers cannot rewrite policy or act as the human approver.

### 7.2 Initial preset

The Research and Draft preset permits reads of an allowlisted source set, candidate writes under the current session's disposable directory, and structured proposals to the broker. It denies direct purchase-request submission, external payment, arbitrary outbound upload, deletion of committed artifacts, access to other sessions, and changes to controller state. SupplierLab write credentials are unavailable in the guest browser, which has at most read access.

### 7.3 Approval binding

Approval data includes an action payload hash, exact resource, intended operation, requester, human approver, policy version, resource version, expiry, and a single-use identifier. Generate the hash from a canonical serialization. A plain "approved" string in a prompt, whiteboard, page, or model response has no authority.

On approval, re-evaluate ownership, live policy, current resource version, session status, and budget. Consume authorization transactionally with the action state change. Changed price, quantity, vendor, destination, or request body invalidates approval. Reject replayed or expired authorization. Do not automatically approve on timeout, disconnect, or restart. Persist pending approvals and cancellations so a reconnect cannot silently execute an old request.

The UI should show one concrete preview, not a vague request to "continue." Repeated harmless reads should not generate approval fatigue. Approval latency and unnecessary approval counts are evaluation outputs.

### 7.4 Avoiding execution bypass

Protect the operation at the resource boundary, not only by recognizing a dangerous button. SupplierLab's write endpoint must authenticate the broker and reject worker/browser identities. Restrict guest networking and avoid passing privileged browser cookies. A browser redirected to a new destination remains subject to destination policy. Denied traffic and failed broker checks generate evidence events. We will test direct HTTP and browser-form bypasses against our own fixture application.

## 8. Core control B: shared budgets and stopping

### 8.1 What the budget measures

Track requests, input/output tokens when reported, estimated token ceilings before a request, execution steps, elapsed time, retries, and worker count. NVIDIA free inference has actual payable inference cost of zero in the prototype. Currency-denominated tests use an explicitly versioned simulated tariff. Do not display simulated spend as an invoice, measured saving, or avoided loss.

Proposed default demonstration limits are two workers, 10 minutes per session, 40 execution steps per worker, 40 combined inference calls, at most two retries per failed model call, and a configurable token ceiling. These are starting configuration values. Tune them after measuring useful-task completion, not to manufacture a good safety result. Count coordinator and verifier model calls if any, not just worker requests.

### 8.2 Reservation protocol

Use one central ledger. Before a call, estimate or bound the permitted consumption and atomically reserve it. The session must have enough remaining allocation for the reservation. Concurrent workers cannot reserve the same balance. Reconcile provider usage when the response completes. Record reservations that remain uncertain after timeout. A retry obtains a new reservation, except where the provider supports a known idempotent accounting mechanism.

If the provider does not return reliable token usage or a response limit cannot bound a dimension, report that dimension as estimated or unavailable. Enforce request, elapsed-time, and step limits independently. The first version must not promise a universally exact dollar cap across unknown billing systems.

On exhaustion, block new calls and new side effects, cancel pending approvals, stop issuing worker leases, and move the session to BUDGET_EXHAUSTED. Preserve existing artifacts and the ledger. Tell the user which deliverables completed and which remain unverified.

### 8.3 Stop protocol

The controller has an independent stop path. First mark the session STOP_REQUESTED and deny new actions. Revoke worker leases and broker authorizations. Signal cancellation to inference calls where supported, stop the runtime workers, and verify process/container state. Save replay data after the critical stop path rather than delaying containment for a video upload. Record outstanding in-flight calls and possible irreversible effects honestly.

A prototype target is to refuse new actions immediately after the persisted stop state and terminate local worker processes within five seconds under the test workload. This is an engineering target, not a benchmark result. A stopped container does not undo a previously submitted transaction or guarantee a remote provider stopped computing.

## 9. Core control C: verified completion and evidence

### 9.1 Task outcomes

Separate READY, RUNNING, AWAITING_APPROVAL, VERIFYING, SUCCEEDED, FAILED, CANCELLED, BUDGET_EXHAUSTED, and NEEDS_VERIFICATION. The model's done response only enters VERIFYING. An exception, maximum-step exit, expired sandbox, or missing result must not become SUCCEEDED because the loop ended.

A session succeeds when all required deliverables pass their contracts. If one worker succeeds and another fails, preserve the successful output and show a partial result through a session outcome that identifies failed tasks. Do not quietly erase failure by rerunning until a demo succeeds.

### 9.2 Verification contract

For the comparison JSON, check schema, requested product and quantity, valid source IDs, nonnegative integer minor-unit prices, currency consistency, and required missing-data markers. Verify asserted prices against the authoritative SupplierLab fixture state, not another copy generated by the agent. Arithmetic is deterministic and uses integer minor units. A claim of availability must match a captured source version.

For a purchase-request draft, verify its linkage to the comparison, resource version, payload hash, and computed total. For an approved submission, independently read the resulting record by receipt ID and verify the final payload, requester, action ID, and idempotency key. A screenshot alone is supporting evidence, not the only verification of a server-side write.

### 9.3 Evidence bundle

Export manifest.json, events.jsonl, budget.json, permissions.json, approvals.json, verification.json, source-index.json, deliverable artifacts, and an optional redacted replay. Include schema versions, model ID, configuration, timestamps, task identities, source versions, and hashes. Distinguish agent statements from verified observations.

Append events from the trusted controller. Reject worker attempts to edit prior events. An append-only application log with a hash chain can detect some later modification, but does not establish independent non-repudiation against a compromised host administrator. Do not market a local file as immutable or blockchain-certified evidence.

## 10. Multi-agent coordination

Keep task assignment push-based and centrally recorded. Each worker owns one research subtask. The first version does not require a sophisticated discovery protocol or a planner that rewrites the whole workflow in flight.

Replace a free-form high-authority whiteboard with typed findings: finding_id, author_agent, source_id, source_version, captured_at, factual_fields, confidence_label, and limitations. Any explanatory text remains untrusted context. It must not appear as new system instructions or carry approvals, capabilities, keys, or hidden commands. Source attribution helps investigation but is not a defense by itself.

The coordinator merges findings only after schema checks. If both agents propose the same external write, the broker's idempotency key and resource-version checks prevent duplicate execution. Parallel local candidate drafts may coexist; publishing one final artifact is a controller-owned action with a recorded version. No shared mutable browser profile or writable cross-agent home directory is permitted.

## 11. Interface and accessibility

The product has a task screen, scope review, two desktop views, a task/status list, action approvals, budget details, and a results/evidence screen. These are product views, not extra project USPs.

Use plain terms: Allowed, Needs your approval, Blocked, Verified, Failed, and Could not verify. Surface the exact resource and rule reason. Avoid claiming to expose private model reasoning; display model-provided explanations as explanations and the policy decision as the authoritative control outcome. Use keyboard-accessible approval and stop controls, visible focus, labelled state changes, adequate contrast, and status text that does not depend only on color.

On model rate limits, show waiting/backoff and remaining limits. On host sleep or controller restart, show disconnected or interrupted. Require an explicit resumed run and a fresh policy check before an uncertain side effect. A first-use setup check should verify runtime, writable task volume, free disk, model access, and loopback ports without asking users to grant personal account access.

## 12. Control API and persistence contract

Proposed routes are POST /sessions, POST /sessions/:id/start, POST /sessions/:id/stop, GET /sessions/:id, POST /actions, POST /approvals/:id/decision, GET /artifacts/:id, and GET /sessions/:id/evidence. Treat names as a design contract pending implementation. GET requests must not resume workers or mutate sessions.

Browser sessions authenticate to the local controller. Bind HTTP and streaming servers to loopback by default. Use an explicit local bootstrap token or password, signed session cookies, origin checks for state-changing operations, and per-resource ownership. Authenticate worker channels separately with short-lived session-scoped credentials. A session ID is not authorization. Check ownership before both in-memory and database return paths. Use separate namespaces or rooms per user and session; never broadcast all session data to an unauthenticated dashboard.

Core tables are users/local_operators, sessions, tasks, workers, policy_versions, actions, approvals, budget_reservations, usage_events, artifacts, verification_results, and audit_events. Store action and request state with transactional transitions and unique idempotency keys. Preserve a monotonically increasing event sequence per session. Store secrets outside these tables and never record them in tool arguments or logs.

Use server-generated artifact IDs and paths. Verify path containment after normalization and reject traversal and symlinks at the storage boundary. Recordings need ownership checks, private cache headers, a deletion/retention setting, and a mode that disables capture. Screen redaction is best effort and must not be presented as comprehensive DLP.

## 13. Model integration and failure handling

Begin with a minimal capability probe against the user's NVIDIA account: authenticated request, small text response, image interpretation, structured or schema-validated action proposal, and usage metadata. Use bounded outputs. Do not copy a provider example that requests tens of thousands of output tokens into the worker loop. Record exact served model and endpoint.

Test text planning and image-based action selection separately. A successful text response does not verify screenshot reasoning or useful GUI control. Use DOM/accessibility actions for the supported browser workflow when possible, keeping screenshots for observation and user visibility. This reduces reliance on coordinate accuracy without claiming that DOM access solves injection.

Centralize rate limiting across coordinator and workers. Apply bounded exponential backoff with jitter and honor Retry-After where available. Classify malformed actions, model refusal, provider errors, timeouts, and unsupported capability separately. Repeated failure must end in a visible failure state, not an unbounded loop.

Fireworks is disabled by default in the zero-cash configuration. Enable it only when the user explicitly chooses that route and its balance, served model, and billing limits are confirmed. Do not alter the user's coding-harness routing as part of this application integration. No provider API key should appear in client-side JavaScript, browser storage, screenshots, evidence exports, or Git history.

## 14. Cost, deployment, and scaling

The baseline has no new paid infrastructure dependency. The laptop runs the controller and local Linux VM. NVIDIA provides trial inference subject to current limits. SQLite and files cover persistence. E2B is excluded because the user's actual workspace displayed a verification-payment gate, even though public pricing advertised credits. That is an account-specific observed restriction, not proof of a universal E2B policy.

Free refers to no additional service payment for the prototype. It does not mean zero electricity, bandwidth, storage, subscription usage, or future operating cost. It does not promise unlimited NVIDIA capacity or production service terms. A final release must display actual payable inference cost as zero when that is the applicable free endpoint, and simulated budget units separately.

For judging, deliver source, installation steps, screenshots, evidence bundles, and a recorded demo. The event permits run instructions where a live deployment is not applicable. Do not force a long-running desktop backend into a free serverless hosting tier. An optional static introduction page can be separate from the runtime. Public remote access requires a separate access-control review and is outside the baseline.

The initial scaling story is an adapter boundary, not a tested claim: runtime.create/observe/act/stop can later target a cloud sandbox provider, while the broker and ledger remain central. SQLite and a single operator will eventually need replacement for distributed multi-user operation. Container isolation is not upgraded to microVM isolation by renaming it.

## 15. Existing solutions and differentiation

E2B supplies sandbox infrastructure. Permit provides authorization and approval capabilities on covered tool paths. LiteLLM supplies model-traffic accounting and limits. LangGraph supports approval and persistence patterns. Enterprise agent-security vendors such as Zenity compete directly with broad runtime-control claims. NVIDIA OpenShell's primary documentation also confirms filesystem, process and network policies, including default denial and request restrictions. TaskLatch cannot claim to invent runtime policy. Integration fit and relative usability remain untested.

These products are not portrayed as missing all controls. Our hypothesis is that a small, local workspace can make task scope, safe execution, and verification understandable in one supported workflow. This is a usability and integration proposition that requires evidence. We have not measured setup-time savings, market demand, willingness to pay, or superiority over enterprise suites.

Opticon is the attributed reference. Its inspected worker code and video motivate exact action gating and truthful completion. Some recovery and stop features already exist there, so our plan strengthens their guarantees rather than claiming they are absent. Before copying any Opticon implementation, verify the license and required notices: its README says MIT, but a dedicated license file was not established in the reviewed tree. Until resolved, write our implementation independently and attribute conceptual inspiration.

## 16. Evaluation and release gates

The full [evaluation plan](docs/EVALUATION_PLAN.md) is a first-class implementation artifact. Every major feature needs a benign case, an adversarial or failure case, and an independent observation of the resulting application state.

Use a controlled baseline inspired by the unguarded action loop, not a claim that we benchmarked an unchanged Opticon deployment. Keep model, tasks, fixtures, and budget configuration fixed where comparison is meaningful. Baseline runs may execute harmful fixture actions only in disposable SupplierLab instances. Never run unrestricted experiments against personal accounts or the public internet.

Release criteria include no forbidden side effect in the enumerated deterministic boundary tests, no approval bypass for payload changes/replay/expiry, no over-reservation in concurrency tests, no failed run labelled successful, and acceptable benign-task completion. All finite-case results must include case counts. "0/12 unauthorized fixture writes" is acceptable after measurement; "100% safe" is not.

Measure model-backed workflow success, false blocks, approval burden, wall time, request/token usage, policy decision overhead, stop latency, and evidence completeness. Predetermine targets and report actual results including regressions. The cost of extra review may be worth the risk reduction, but the product must demonstrate that useful work still completes.

## 17. Delivery schedule

| Date, IST | Milestone | Exit evidence |
| --- | --- | --- |
| 1 Nov | Round 1 proposal, 10-slide PPT, implementation/evaluation plan | Required-section map and source-backed claims |
| 2 Nov | Model and local-runtime capability spikes | Recorded model probe and two constrained desktops |
| 3–4 Nov | SupplierLab, task schema, controller, one-worker vertical slice | Saved comparison candidate and independent read check |
| 5–6 Nov | Second worker, structured findings, artifact merge | Two-source comparison with correct attribution |
| 7–8 Nov | Broker and exact approval state machine | Negative approval cases and authorized fixture write |
| 9 Nov | Shared reservation ledger and stop path | Concurrent reservation and cancellation evidence |
| 10–11 Nov | Verification states, replay privacy, evidence export | Failed runs remain failed and final receipt checks |
| 12 Nov | Full model-backed scenario suite and baseline | Versioned raw results including failures |
| 13 Nov | Repair material regressions and freeze scope | Repeat only affected checks plus final full flow |
| 14 Nov | README, recording, reproducible clean setup | Another-user setup instructions and final evidence |
| 15 Nov | Buffer and prototype submission by official deadline | Verified submission receipt after user authorization |

If a capability spike fails, cut scope before expanding features. The minimum fallback is one worker plus the complete broker/budget/verification path, clearly disclosed. Two workers remain the target because concurrency is necessary to demonstrate a shared ledger. Cloud desktops are not a fallback that requires the user to pay.

## 18. Risks and mitigations

| Risk | Early signal | Response |
| --- | --- | --- |
| Model cannot reliably operate the desktop | Fails basic controlled navigation or emits invalid actions | Use browser DOM tools and bounded schemas; retain screenshots for observation; disclose the supported workflow. |
| NVIDIA access unavailable or throttled | Probe failure or repeated 429s | Queue centrally, reduce concurrency, use recorded test fixtures for offline controls; do not present a replay as live inference. |
| Local desktop images exceed disk/RAM | Slow startup, swapping, low space | Two workers, lean arm64 images, bounded disk, disable heavy capture; seek user direction before any unrelated cleanup. |
| Action bypass via authenticated browser | Direct write succeeds without broker | Remove guest write credentials and enforce resource-side authorization before proceeding. |
| Retry duplicates a submission | Uncertain receipt after timeout | Idempotency and read-after-timeout reconciliation; no blind retry. |
| Approval fatigue blocks useful work | Excessive approvals on benign workflow | Gate consequential operations, not every read or mouse move. |
| Free-tier or provider terms change | Endpoint deprecation or account restriction | Recheck before demo; maintain an adapter; no paid auto-fallback. |
| Scope expands into universal agent security | New integrations consume implementation time | Freeze supported actions, preserve three core controls, defer additional agents. |
| Originality or license ambiguity | Existing platform overlap or unclear notices | Disclose inspiration, implement independently pending license verification, state the actual contribution. |
| Benchmark looks safe because nothing works | Low benign success with few side effects | Report utility alongside safety and reject a block-everything result. |

## 19. Impact and honest presentation

The intended beneficiaries are small teams and learners testing agent delegation without exposing production accounts or purchasing infrastructure. Expected benefits are narrower unintended authority, bounded resource consumption, clearer review, and fewer falsely successful outcomes. These are hypotheses until tested.

Do not claim a percentage reduction in incidents, financial savings, customer adoption, or production readiness in Round 1. Show the measurement method and the proposed acceptance targets instead. The slide deck must distinguish the existing Opticon reference from TaskLatch's proposed work, free API inference from simulated prices, and local containers from cloud microVMs.

The screenshot's required sections are the actual presentation contract. A numerical judging-weight rubric was not found in the inspected listing, so none is invented. [Requirements and slide map](docs/REQUIREMENTS_AND_SLIDES.md) ties each slide to a requirement and the evidence that will eventually support it.

## 20. Completion checklist for this planning stage

- [x] Save the plan, evidence register, evaluation contract, backlog, and slide map in this workspace.
- [x] Create an editable 10-slide idea-submission PPTX with Team Update and Shikhar.
- [x] Include source citations and substantive caveats in notes and necessary on-slide disclosures.
- [x] Keep forecasts, proposed interface elements, and planned tests labelled appropriately.
- [x] Render and inspect every slide; repair layout before delivery.
- [x] Keep this task limited to planning and presentation creation. No prototype runtime installation, paid API use, account creation, entry submission, or publication was performed.

Delivered deck: [TaskLatch-CodeQuest-2026.pptx](presentation/output/TaskLatch-CodeQuest-2026.pptx). The artifact validation and visual review are recorded in [presentation/README.md](presentation/README.md). These are presentation checks, not prototype results.
