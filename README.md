# TaskLatch

**Controlled local desktops for AI agents**  
**Team:** Team Update  
**Presenter:** Shikhar  
**Event:** CodeQuest: National Tech Hackathon 2026, DotRepo  
**Status:** idea-stage proposal and implementation plan, 1 November 2026

TaskLatch is a proposed workspace for two AI agents working in local Linux desktops. Its contribution is an external permission and approval layer, a shared execution budget, and completion checks tied to observable results. Opticon is an attributed reference for the parallel-desktop interaction pattern, not work owned by this team.

## Project documents

- [Detailed project plan](PROJECT_PLAN.md): scope, user workflow, architecture, implementation contracts, controls, delivery schedule, risks, and release gates.
- [Evidence register](docs/EVIDENCE_REGISTER.md): primary sources, caveats, reviewed Opticon code, and account-specific E2B payment restriction.
- [Evaluation plan](docs/EVALUATION_PLAN.md): metrics, experiment design, cases, reporting, and release criteria.
- [Requirements and slide map](docs/REQUIREMENTS_AND_SLIDES.md): every official Round 1 requirement mapped to the presentation and prototype evidence.
- [Decisions and unresolved checks](docs/DECISIONS_AND_OPEN_QUESTIONS.md): user-approved constraints, proposed implementation choices, and remaining gates.
- [Prototype backlog](docs/PROTOTYPE_BACKLOG.md): implementation order with concrete acceptance criteria.
- [Final editable presentation](presentation/output/TaskLatch-CodeQuest-2026.pptx): 10 slides with Team Update and Shikhar, editable tables, source-linked speaker notes, and the planned evaluation.
- [Presenter notes](presentation/PRESENTER_NOTES.md): the full narrative and source links, also embedded in the PPTX.
- [Presentation source and checks](presentation/README.md): authoring files, asset provenance, and validation scope.

## Current boundaries

No prototype has been implemented or benchmarked yet. No API key has been supplied or tested. Colima and Docker clients are installed, but the runtime was stopped at the environment check. E2B is excluded from the baseline because the user's workspace requires a verification payment. NVIDIA's hosted model access remains subject to trial availability and account limits.

The local design uses separate containers inside one Linux VM. It does not provide a separate hardware-isolated VM for each agent. There is no claim of universal prompt-injection prevention, guaranteed reversal of external actions, measured cost savings, or production certification.

## Immediate next steps

1. Review the 10-slide idea-submission deck.
2. Confirm model image/tool-call support with a securely configured NVIDIA key.
3. Build the smallest end-to-end workflow in the backlog.

Do not put secrets, personal browser profiles, captured personal screens, database contents, or runtime credentials in the repository. Keep generated runtime artifacts out of version control by default.
