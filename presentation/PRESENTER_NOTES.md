# TaskLatch presenter notes

All capabilities and targets are proposed unless explicitly described as sourced evidence.

## 1. TaskLatch

TaskLatch is an independently planned local computer-agent control project. The idea is to keep delegated browser work useful while putting consequential actions behind controller-enforced permissions, shared resource limits and independent outcome verification. The working scope is two local desktop workers, one synthetic supplier workflow and no mandatory paid infrastructure. Team name and presenter are provided by the user. Cover illustration is AI-generated conceptual art, not evidence of an implemented application.

- CodeQuest official requirements: https://unstop.com/hackathons/codequest-national-tech-hackathon-2026-dotrepo-1771441/amp
- Opticon reference: https://github.com/23jmo/opticon

## 2. Delegation can outgrow permission

The headline is a survey finding, not a measured incident rate per task. CSA surveyed 418 IT and security professionals in January 2026, with Token Security funding and co-developing the questionnaire. Sixty-five percent reported an incident involving AI agents or autonomous workflows in the prior twelve months. Among incident-affected respondents, 35 percent reported financial cost, but the source does not establish an average dollar loss. Do not extrapolate a market-wide loss. The three examples at right are the proposed product problem boundaries. Demand for the specific small-team supplier workflow remains a user-research hypothesis. We exclude the unverified viral Clawdbot purchase anecdote from headline evidence.

- CSA announcement: https://cloudsecurityalliance.org/press-releases/2026/04/21/new-cloud-security-alliance-survey-reveals-82-of-enterprises-have-unknown-ai-agents-in-their-environments
- First-party incident account, separate qualitative evidence: https://www.saastr.com/replits-new-release-address-most-of-the-challenges-we-hit-vibe-coding-but-is-prosumer-vibe-coding-really-ready-for-commercial-apps-yet/

## 3. Supplier research with a controlled handoff

The initial workflow deliberately stops at a purchase request in a local fixture application, not an actual purchase or external email. SupplierLab will contain synthetic vendor pages and a local request database. Two workers research in parallel. Their browser sessions have read authority only. They produce citations, comparison data and a draft. Only a controller-owned action broker can create the final test request after exact approval. A separate verification read checks the receipt and its expected fields. This makes the important boundary observable without spending money or giving the agent access to personal accounts. User frequency and willingness to adopt still require interviews.



## 4. Bounded work, from request to receipt

These are the three core additions, not an invitation to add a large feature catalogue. Exact approvals, budgets and runtime controls already exist in other products. Our proposed contribution is their coherent application to a small, locally runnable computer-agent workflow with a clear controlled commit and evidence of the outcome. Policy is enforced by the controller and request service, rather than by hoping a system prompt will be obeyed. A reservation ledger accounts for concurrent workers. Verification is separate from the worker narrative. Evidence must include useful task completion as well as prevention. All capabilities on this slide are proposed.

- Comparable approval pattern: https://docs.permit.io/permit-mcp-gateway/human-in-the-loop
- Comparable runtime policies: https://docs.nvidia.com/openshell/how-it-works/policies/overview

## 5. Approval binds to the exact action

This is an illustrative action, not a screenshot or test result. The broker canonicalizes the destination, action type, resource, exact payload, relevant policy version and idempotency key. A user approval records the bound hash and expiry. The broker consumes approval atomically and checks it again immediately before the write. Editing quantity, price, destination or policy invalidates the approval. Retries cannot reuse a consumed approval to create a second request. The backend must enforce write authority independently of the browser UI. Workers have no write token and no route that bypasses the broker. Approval identity, expiry, denial, duplicate submission, race conditions and time-of-check/time-of-use changes are part of the evaluation cases. The sample arithmetic is 20 multiplied by 450 equals 9,000.



## 6. Desktop delegation with enforceable boundaries

This comparison describes documented product scope, not an independently benchmarked ranking or a claim that competitors cannot add the proposed workflow. Opticon is the direct orchestration reference. A static review at commit ce4d098ed5ba86e564da72ddb816716b4b72c602 and its demonstration showed task approval, desktop orchestration and replay. The reviewed worker emits completion events after certain error paths, so independent verification is a concrete area to improve in our own implementation. This is not a full Opticon security audit. E2B is excluded because this user account requires a verification payment, regardless of public credit wording. Permit and LangGraph already support approval patterns. LiteLLM covers model traffic. OpenShell explicitly documents filesystem, network and process policy, while Zenity makes directly overlapping runtime-control claims. We must earn differentiation through the specific workflow, transparent boundaries and evaluation, not a first-ever claim. Opticon source reuse rights and notices must be verified before any copying. Baseline will be our own Opticon-inspired loop, not an unchanged Opticon benchmark.

- Opticon: https://github.com/23jmo/opticon
- Opticon demo: https://www.youtube.com/watch?v=Sc6lU9XTJmo
- E2B: https://e2b.dev/pricing
- Permit: https://docs.permit.io/permit-mcp-gateway/human-in-the-loop
- LangGraph: https://docs.langchain.com/oss/python/langchain/human-in-the-loop
- LiteLLM: https://docs.litellm.ai/docs/proxy/architecture
- OpenShell: https://docs.nvidia.com/openshell/how-it-works/policies/overview
- Zenity: https://zenity.io/platform/runtime-boundaries

## 7. Two local desktops, one trusted controller

A dedicated local Colima Linux VM hosts two Linux desktop containers. These are not separate cloud machines or separate microVMs per agent. The host must remain awake and performance is untested. The controller remains outside worker authority and retains provider credentials. Worker screenshots and read actions are structured inputs. Browser mutation is disabled by server authorization, not by hiding a button. The controller broker is the only write principal. The initial runtime spike must prove screenshot, click/type, independent noVNC views and reliable stop for both workers without personal home shares, personal browser profiles or daemon sockets. Containers share the VM kernel, so this is a constrained prototype boundary, not a claim of complete malware isolation. Candidate NVIDIA model: nvidia/nemotron-3-nano-omni-30b-a3b-reasoning. Image input, structured actions and actual key limits require testing. A local model adapter seam and runtime adapter seam allow future alternatives, but cloud portability is not implemented.

- Colima: https://github.com/abiosoft/colima
- Docker security: https://docs.docker.com/engine/security/
- NVIDIA candidate: https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning

## 8. Useful completion must survive the controls

The detailed evaluation protocol is docs/EVALUATION_PLAN.md. The 34 deterministic cases cover approval identity, changes and expiry; concurrent reservations; verification of missing or incorrect receipts; untrusted content; operational stop and recovery; and cost reporting. Seventy-two planned model-backed sessions means six benign tasks plus six challenge tasks, each repeated three times in two modes. Modes are our own baseline loop and the controlled TaskLatch mode. These are repeated sessions over 12 scenarios, not 72 independent task designs. Record actual denominators, blocked action attempts, legitimate completion, false blocks, false success, approval burden, resource usage, overhead and stop latency. Targets shown are release aspirations, not measurements or guarantees. A stop target of five seconds applies only under the defined prototype workload. There must be no claim of safety based on blocking every task. Store raw evidence and preserve failure cases. On a free endpoint, financial-cap tests use an explicitly simulated tariff; no measured dollar savings should be claimed. Run feasibility and model checks before committing to the full model-backed batch.



## 9. A zero-cash prototype with early gates

The baseline requires no mandatory cash payment for cloud desktops or application hosting. This assumes existing laptop and internet access, working local runtime support and usable NVIDIA free hosted endpoint access. Electricity and internet are not represented as literally costless resources. NVIDIA free access is quota- and availability-dependent, not an unlimited production entitlement. No key has been supplied or tested. Fireworks API calls are usage billed and remain disabled unless credits and spending authorization are confirmed. E2B is not a dependency because the actual user account is payment blocked. Dollar-budget scenarios use simulated tariffs, while actual request and token counters are measured. If vision or structured action tests fail, do not silently claim computer-use support or switch to a billable provider. Record the limitation and use the deterministic fixture to establish control logic while the provider gate is resolved. Detailed backlog, dependency order, acceptance criteria and hardware constraints are in the project plan. The prototype window follows the event listing and should be rechecked before submission.

- Event: https://unstop.com/hackathons/codequest-national-tech-hackathon-2026-dotrepo-1771441/amp
- NVIDIA candidate: https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
- NIM access: https://docs.api.nvidia.com/nim/docs/run-anywhere
- Fireworks pricing: https://fireworks.ai/pricing

## 10. Delegated work with a reviewable outcome

Expected beneficiaries are hypotheses, not validated customer segments. Intended impact is fewer unauthorized writes and fewer false completion reports while retaining acceptable legitimate completion and approval effort. The prototype must show both the successful path and blocked/error paths, with inspectable action records, receipt checks and actual metric denominators. Do not present projected financial savings, customer counts or production safety guarantees. Scalability is an architectural path through runtime and action adapters, not a claim that this laptop prototype scales to an enterprise fleet. The local first version is intentionally constrained to two workers and one workflow. Team Update will independently implement the project and disclose Opticon inspiration. Source reuse requires license verification and notices. The judging criteria have not been given numerical weights; the deck maps visibly to the official required topics without inventing scores.

- Originality and required topics: https://unstop.com/hackathons/codequest-national-tech-hackathon-2026-dotrepo-1771441/amp
- Orchestration inspiration: https://github.com/23jmo/opticon