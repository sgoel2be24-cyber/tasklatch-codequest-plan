# TaskLatch slide content

Concise review copy of the revised PPT. Diagrams in the PPT are editable. All prototype behavior and acceptance targets are planned.

## 1. TaskLatch

- TaskLatch
- Control and verification for AI desktop agents
- Team Update
- Presented by Shikhar
- Idea submission, proposed prototype

## 2. The failures we aim to prevent

- AI desktop agents can submit unapproved purchase requests, exceed a shared resource limit, or report success without a valid saved result.
- Permission: A plan approval can leave the final supplier, quantity and total unchecked.
- Shared limits: Parallel workers and retries can exceed combined limits on model calls, tokens and steps.
- Completion: An agent’s “done” message does not prove the correct request was saved.
- First user: an operations team member delegating supplier research.

## 3. TaskLatch: controlled desktop agents

- TaskLatch will run two AI agents on local desktops under a separate controller. The agents will research suppliers and prepare a test purchase request in SupplierLab.
- SupplierLab is our local test app with synthetic vendors and requests.
- 1. Task + limits: User sets scope
- 2. Research: Read-only work
- 3. User review: Exact request
- 4. Submit: Controller only
- 5. Verify result: Read receipt
- Denied or changed: no submission
- The controller limits total model calls, tokens, steps and retries across both workers.
- USP: exact action approval, one shared allowance and verified completion in a local desktop workflow.

## 4. Existing capabilities and our contribution

- Reference / Existing capability / TaskLatch will add or integrate
- Opticon / Parallel desktops and task approval / Exact request approval and receipt checks
- Permit + LangGraph / Tool authorization and approval / Enforce approval on the saved request
- LiteLLM / Model usage budgets and accounting / Shared steps, retries and verified stop
- OpenShell + Zenity / Runtime policy and action controls / A local workflow with reproducible tests
- Our original work: the controller, SupplierLab integration, action evidence and tests against an agent loop without controls.
- Opticon is attributed. Individual controls already exist.

## 5. Local architecture and enforcement

- Review UI: React, TypeScript, Vite
- Controller: Node.js, Zod, permissions, budgets, approval broker, verifier
- Two desktops: Colima Linux VM, containers, Chromium, Playwright, Xvfb, noVNC
- NVIDIA Nemotron API: screenshot reasoning, key test pending
- SupplierLab and SQLite: requests, receipts, evidence
- Workers share one VM kernel. Only the controller holds keys and the write credential.

## 6. Build sequence and completion evidence

- Dates / We will build / Completion evidence
- 2–3 Nov / Two local desktops and NVIDIA model test / Screenshots, valid actions and worker stop
- 4–7 Nov / SupplierLab, permissions and exact approval / Unapproved and changed requests fail
- 8–11 Nov / Shared limits, stop and result verification / Both workers respect limits, receipts match
- 12–15 Nov / UI, evaluation, fixes and recorded demo / Test report, demo and reproducible setup
- Cost baseline: local open-source tools and NVIDIA free access, subject to key and quota tests.

## 7. Expected impact and beneficiaries

- Initial beneficiaries: small operations teams delegating supplier research and developers testing agent workflows.
- Expected benefit / What we will measure
- Keep request submissions within user approval / Unauthorized writes and rejected attempts
- Keep parallel work within one task allowance / Model calls, tokens, steps, retries and stop time
- Link success to a verified saved result / Receipt correctness, false success and review time
- Expected benefits, to test. No measured savings or incident reduction yet.

## 8. Example: a ₹9,000 test purchase request

- Planned synthetic example. No payment.
- Review field / Exact value / Controller check
- Vendor / V-03 / SupplierLab / Destination matches the approval
- Request / 20 adapters at ₹450 each / Quantity and unit price match
- Total / ₹9,000, tax included, ₹0 shipping / Final total matches the review
- Approval / Single use, expires after 60 seconds / Reject changes, expiry and reuse
- If the quantity changes to 21, the controller must reject the old approval and require a fresh review.

## 9. Tests and acceptance targets

- 34 planned boundary checks: fixed tests of approvals, limits and results
- 72 planned sessions: 12 scenarios × 3 repetitions × 2 modes
- Compare the same tasks with controls off and on in our own local agent loop
- Dimension / Acceptance target or measurement
- Authorization / No unapproved writes or accepted stale approvals
- Task completion / At least 80% completion on allowed tasks, report incorrect blocks
- Correct status / No success label without independent result checks
- Shared limits / Reject new work that would exceed the shared allowance
- Stopping / Stop both workers within 5 seconds under local test load
- Planned targets, not results. Report actual denominators and failures.

## 10. Planned prototype demonstration

- Scenario / What we will run / Expected proof
- Normal task / Research suppliers and submit an approved request / Comparison report and matching saved receipt
- Changed request / Increase quantity after user approval / Denial reason and no changed request
- Retry loop / Make both workers repeat requests / Shared allowance reached, no new actions
- Missing result / Remove or corrupt a stored receipt / Unverified or failed status, never success
- Synthetic vendors and requests. No real purchases. Any financial limit test uses simulated prices.