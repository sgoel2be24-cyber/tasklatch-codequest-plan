# Opticon features and TaskLatch

Opticon ([23jmo/opticon](https://github.com/23jmo/opticon), commit `ce4d098`, reviewed 8 November 2026) is the attributed reference for TaskLatch's parallel-desktop pattern. This page lists what its code does, what TaskLatch now does for each item, and what was deliberately not adopted. TaskLatch keeps its three controls throughout: operator-defined permissions, one shared allowance, and independent verification.

## Added to TaskLatch

| Opticon feature (where in its code) | TaskLatch now | How the controls still apply |
|---|---|---|
| Full internet access in each sandbox (E2B desktops) | Site presets (Wikipedia, Bing, Brave Search, GitHub, Stack Overflow, Hacker News, MDN, Python docs, SupplierLab) and an **Any public website** (`*`) option | `*` covers public hosts only. Private, loopback, link-local and `.local` addresses are excluded, and the TaskLatch controller is never reachable even if listed. The proxy resolves each name once, refuses names that resolve to private addresses unless listed by name, and connects to the address it checked. Form posts stay blocked. |
| — (agents simply have the open web) | **Allow sites while a task runs.** Every refused host appears in a *Sites* panel with an *Allow* button, and you can type one in | Each change is an operator decision with a new policy version, takes effect on the desktop's next request, and every agent is told. Hosts can also be removed. |
| Thinking sidebar with reasoning and tool calls (`thinking-sidebar.tsx`) | **Agent reasoning** panel: each step's thought and action, the outcome, and blocked actions, filterable per agent. The latest thought is also shown under each desktop | Thoughts are labelled agent statements; outcomes come from TaskLatch's own observations. |
| Per-agent "Command…" box (`agent-grid.tsx`) | **Message one agent or all agents** from the live view | In the reviewed Opticon code the browser emits `agent:command` but no server handler exists. In TaskLatch the message reaches the agent's next step, is recorded as an operator decision, and cannot unlock blocked actions. |
| Lanes: many small tasks, run in order per agent (`orchestrator.ts`, `getNextPendingTask`) | **Subtask queues.** Up to 8 subtasks across 1–4 agents; each agent works through its queue on one desktop | One step allowance per agent covers its whole queue. Stop, allowance exhaustion or the step limit end the remaining queue, with each task marked accordingly. |
| Approve page with "refine" (`approve/page.tsx`, `refine/route.ts`) | **Plan editor:** pick the agent for each subtask, add and remove subtasks, or ask the coordinator in plain language to revise the plan | A revision is one model call from the shared allowance. Start pages outside the approved sites are replaced. |
| Follow-up prompts after agents finish (`session:followup`) | **Follow up** on a finished web task | The follow-up is a new linked task with the same sites, fresh desktops, and only the parent's source-checked findings as context. You review its plan before it starts. |
| Agents produce files, e.g. "a comparison spreadsheet" (via terminal or office apps) | **`save_file`** action: agents save `.csv`, `.md`, `.txt` or `.json` files in their own task folder; the report offers a **CSV of all findings** | Files are agent statements. TaskLatch records their hashes, the verifier checks that they are unchanged, and the files are served as sandboxed downloads. Spreadsheet formulas are neutralised in the CSV. |
| Web search by opening a browser | **`search`** action using an approved engine (Bing, then Brave Search, then Wikipedia search) | The search URL is checked like any navigation. Agents are told never to solve CAPTCHAs. |
| Replay scrubber and GIF timelapse (`replay-scrubber.tsx`, `gif.py`) | **Replay player** per agent: play/pause, previous/next, a slider, arrow keys, and each frame captioned with the decision that followed it. **Download timelapse** makes a WebM video in your browser | Screens stay private. The timelapse is made locally and nothing is uploaded. |
| Session summary page (`session-summary.tsx`) | **Session complete** card: findings source-checked, agents, subtasks, run time, model cost, files, and links to the report, CSV and evidence | Numbers come from the verifier and the ledger, not from the agents. |
| Panopticon dashboard of running sessions with thumbnails (`panopticon-view.tsx`) | **Running now** on the home page: the latest screen from each agent, status, subtask progress and time left, refreshed every 3 s; tasks are grouped by day | Thumbnails are the private replay frames, shown only to the signed-in operator. While you have taken over a desktop its thumbnail keeps updating. |
| Mobile layouts | Responsive layout down to phone width | — |

## Fixed while doing this

- When the shared allowance ran out in an open-web task, the findings already recorded were not assembled. TaskLatch now builds the report from them (listing the findings when no model summary is possible) and source-checks it.
- The exhaustion reason was always reported as "model calls". It now names the limit that actually ran out, for example the token ceiling.
- The composer shows how many agent steps your paid spend cap covers (about 3,000 tokens per desktop step with a screenshot) and warns when that is tight for the number of agents.
- **Re-run check** on a web task re-ran the supplier checks; it now re-runs the report source check.
- The evidence bundle described every task as running in headless browser contexts; it now names the container runtime and the approved sites.

## Not adopted, and why

| Opticon | Reason |
|---|---|
| E2B cloud sandboxes | Zero-cash, local-only constraint. TaskLatch uses Docker in a local Colima VM. |
| A terminal and any desktop app in the sandbox | The desktop image has no shell, so network enforcement at the browser holds. Agents save files through `save_file` instead. |
| Pausing sandboxes and reusing them for follow-ups | Each task gets fresh desktops so browser state and files stay task-specific. Local containers start in a few seconds. |
| Per-user memory across sessions (Mem0) | Not built. Follow-ups carry the parent's source-checked findings instead. |
| Slack bot and step checkpoints | Needs a Slack workspace; TaskLatch is local-only. Step limits and the shared allowance bound each run instead. |
| Google sign-in, Postgres, billing | Single local operator. |
| Socket.io push updates | The UI still polls once per second. |
| Drag-and-drop kanban during approval | Replaced by an agent picker per subtask, which also works from the keyboard. |
