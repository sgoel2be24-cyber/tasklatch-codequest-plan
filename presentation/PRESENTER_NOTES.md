# TaskLatch presenter notes

Content revision: problem on slide 2, proposed solution and USP on slide 3. All capabilities and targets remain planned unless explicitly identified as sourced evidence.

## 1. TaskLatch

TaskLatch is Team Update’s proposed local workspace for AI desktop agents. Two workers will research suppliers while a separate controller enforces permissions, a shared resource allowance and independent completion checks. Presenter: Shikhar. This is an idea-stage proposal, not an implemented or benchmarked system. Opticon is an attributed orchestration reference.

- https://unstop.com/hackathons/codequest-national-tech-hackathon-2026-dotrepo-1771441/amp
- https://github.com/23jmo/opticon

## 2. The failures we aim to prevent

The problem is a gap between a delegated task and the authority, resource use and actual result of an agent run. The first user and supplier workflow are proposed, not validated customer demand. We will target three observable failures: a purchase-request write outside exact user approval, parallel work exceeding the shared allowance, and a success status despite missing or incorrect saved output. These risks are conditional on the integration and permissions, not claims that every agent product lacks controls. The reviewed Opticon worker source and demonstration motivate independent verification, but they are not a full security audit. Supporting industry evidence: a CSA / Token Security January 2026 survey of 418 IT/security respondents found that 65% reported an agent or autonomous-workflow incident in the preceding year. It is self-reported, broadly defined, vendor-funded and does not establish a per-task incident rate or average monetary loss. The problem statement, rather than that statistic, leads the slide.

- Industry evidence: https://cloudsecurityalliance.org/press-releases/2026/04/21/new-cloud-security-alliance-survey-reveals-82-of-enterprises-have-unknown-ai-agents-in-their-environments
- Reviewed reference: https://github.com/23jmo/opticon/blob/ce4d098ed5ba86e564da72ddb816716b4b72c602/workers/worker.py
- Reference demonstration: https://www.youtube.com/watch?v=Sc6lU9XTJmo

## 3. TaskLatch: controlled desktop agents

This is the proposed solution, not a screenshot of an existing product. The user sets the task, allowed sources and shared resource limits. Two local workers research read-only synthetic vendor pages and produce a comparison and draft request. The controller presents the exact destination, vendor, quantity, unit price and final total for user approval. The write broker submits only that exact approved operation. A separate verifier reads the stored receipt and checks its fields and the saved report before the UI can claim success. Rejection, changed content or expired approval prevents submission and triggers fresh review when appropriate. Resource reservations apply to the coordinator, both workers, model calls and retries throughout the run, rather than only at a single step. Unknown and failed results remain distinct from success. The workflow integration is our proposed USP; authorization, runtime controls and tracing are established categories.



## 4. Existing capabilities and our contribution

This is a scope comparison based on primary documentation, not an independently benchmarked competitor ranking. TaskLatch does not claim to invent approvals, budgets, sandboxing or runtime policy. Opticon is the direct parallel-desktop and task-approval reference. TaskLatch’s proposed original work is the independently implemented controller, SupplierLab’s enforced write boundary, structured approval/action/result evidence and paired evaluation against our own baseline loop. Permit and LangGraph already provide integrated authorization and approval patterns. LiteLLM already covers model-traffic budgeting. OpenShell documents filesystem, process and network policy, while Zenity makes directly overlapping runtime-control claims. Our desktop workflow must integrate the controls and prove useful completion as well as blocked forbidden writes. Source reuse requires license and notice verification before copying. The initial version is a focused local prototype, not a universal security gateway.

- https://github.com/23jmo/opticon
- https://docs.permit.io/permit-mcp-gateway/human-in-the-loop
- https://docs.langchain.com/oss/python/langchain/human-in-the-loop
- https://docs.litellm.ai/docs/proxy/architecture
- https://docs.nvidia.com/openshell/how-it-works/policies/overview
- https://zenity.io/platform/runtime-boundaries

## 5. Local architecture and enforcement

This diagram is the proposed architecture. It is not a claim that the runtime has been started or tested. The React/TypeScript/Vite interface communicates with a separate Node.js controller over HTTP/WebSocket for approvals, status and control. Zod validates structured action and result schemas. The controller orchestrates a dedicated Colima Linux VM containing two desktop containers, running Chromium, Playwright, Xvfb and noVNC. Desktop commands and screenshots pass through the controller. The NVIDIA key stays with the controller, which sends screenshots to an image-capable model and validates returned action proposals. Candidate: nvidia/nemotron-3-nano-omni-30b-a3b-reasoning. Image input, reliable structured actions, actual key access and usage limits require a capability probe. The worker browser identity has read authority only. SupplierLab’s server allows a write only from the controller broker after authorization, so a direct browser form or HTTP request cannot bypass review. SQLite holds request/receipt and trusted control state. The verifier uses an independent read of saved state. Containers share the VM kernel, so this is not a separate microVM per worker or production malware-isolation claim. No host-home shares, personal browser profiles, provider keys or daemon sockets enter the workers.

- https://github.com/abiosoft/colima
- https://docs.docker.com/engine/security/
- https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning

## 6. Build sequence and completion evidence

These are proposed milestones for the event’s 2–15 November prototype window. The first milestone must prove that the existing laptop can run two desktops, produce screenshots, execute structured actions and stop workers, while a real NVIDIA key confirms image access, usage metadata and practical request limits. No model key has yet been supplied or tested. Do not promise reliable computer use from the model page alone. The next milestone builds SupplierLab and the external authorization boundary, followed by shared reservations, an independent stop path and receipt verification. The final milestone runs the evaluation protocol and packages reproducible setup, failure evidence and a labelled recorded fallback. The zero-cash baseline assumes the existing laptop, internet and usable NVIDIA free access. E2B is excluded because this user account requires a verification payment. Fireworks stays off unless credits and spending authorization are confirmed. If model or hardware gates fail, record the limitation rather than substituting a billable dependency or pretending a scripted path is a live agent result. The schedule is an implementation plan, not completed progress.

- https://unstop.com/hackathons/codequest-national-tech-hackathon-2026-dotrepo-1771441/amp
- https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
- https://docs.api.nvidia.com/nim/docs/run-anywhere
- https://fireworks.ai/pricing

## 7. Expected impact and beneficiaries

The initial beneficiary segments and adoption assumptions have not been validated through user research. The proposed benefit is narrower authority and resource use while retaining useful supplier research. The evaluation will count actual forbidden writes and rejected attempts, not merely model refusals. It will report resource reservations, reconciled consumption and stopping latency. Independent receipt and report checks will expose false success. Measure operator review time and false blocks as usability costs, so preventing every action does not masquerade as useful impact. No financial saving, percentage incident reduction, customer traction or production-readiness result is claimed. Real-world impact and demand require later user testing. The first prototype uses synthetic vendors and purchase requests in SupplierLab.



## 8. Example: a ₹9,000 test purchase request

This example is a design contract, not a test result or actual purchase. Twenty adapters at ₹450 each totals ₹9,000, including tax and with no shipping charge. Exact approval binds the action type, destination, supplier/resource version, payload, policy version and idempotency key. It expires after the proposed 60-second review window and is single-use. The controller rechecks authorization at execution and consumes it atomically. A changed quantity of 21 would imply a different total and a different payload, so old approval must not authorize it. Direct worker writes, expired approvals and token replay must fail at SupplierLab’s server boundary. A matching persisted receipt is necessary before success. If an acknowledgement is lost after a write, read by idempotency key before retrying to avoid duplicate requests.



## 9. Tests and acceptance targets

All figures are planned experiment sizes and internally chosen engineering targets, not measured results or official judging weights. The detailed protocol is docs/EVALUATION_PLAN.md. The 34 deterministic cases cover approval changes, expiry, identity and replay, direct-write bypass, concurrent reservations, stopping, missing or invalid receipts, untrusted page findings and operator access. The 72 planned model sessions consist of six benign and six challenge scenarios, each repeated three times in two modes. Our baseline is an independently built Opticon-inspired loop, not unmodified Opticon. Both modes use the same synthetic fixture tasks, versions and resource ceilings. Count meaningful benign completion as verified correct deliverables over all benign sessions, and report false blocks. Distinguish attempted forbidden writes, policy denials and actual resource changes. Zero observed failures in a small set does not prove universal prevention. The five-second stopping target applies to the defined local workload and requires independent process-exit timestamps, separate from the time the controller refuses new work. Report actual executed counts, timeouts, provider failures and missing token usage. If free access limits prevent the planned batch, explicitly report incompleteness. Preserve raw failures and avoid changing targets after results are known.



## 10. Planned prototype demonstration

The final prototype should show a useful successful task and controlled failure paths, not just a safety dashboard. In the normal path, the two desktops produce supplier comparisons, the user approves an exact request, the controller submits it and the verifier reads a matching saved receipt. In the changed-request case, the attempted mutation must not create a changed request. In the retry case, the shared reservation ledger and independent stop path must prevent new work after the allowance is exhausted. In the missing-result case, the UI must preserve unverified/failed status rather than accepting an agent success message. Show action, approval, budget, result and verification evidence. These are expected demonstrations, not completed tests. All business data is synthetic and no real purchases, production credentials or external email are involved. Actual model request/token counts are measured when the provider reports them. Currency-budget scenarios use explicitly simulated tariffs, not an invoice or measured financial savings. E2B is excluded, Fireworks is off without confirmed credit/spending authorization, and NVIDIA free endpoint access remains dependent on a real-key capability/limit test. Cloud runtimes and new business integrations are later extensions after the local boundary works.

