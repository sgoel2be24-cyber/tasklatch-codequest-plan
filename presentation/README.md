# TaskLatch presentation

Final file: [TaskLatch-CodeQuest-2026.pptx](output/TaskLatch-CodeQuest-2026.pptx).

The deck contains 10 slides, six editable native PowerPoint tables, and speaker notes for every slide. Team name is **Team Update** and presenter is **Shikhar**. It covers the official problem, solution/USP, differentiation, technology, implementation and impact requirements. The evaluation is a proposed prototype protocol, not completed results. No public numerical judging weights were found, so none are invented.

## Files

- `build_deck.mjs`: JavaScript authoring source using `@oai/artifact-tool`.
- `verify_deck.mjs`: read-only import and rendering of the exact final PPTX.
- `PRESENTER_NOTES.md`: readable copy of all presenter notes and source links.
- `assets/tasklatch-cover.png`: conceptual cover illustration. See [asset provenance](assets/README.md).
- `output/TaskLatch-CodeQuest-2026.pptx`: the final review copy. Earlier working exports are private under `.build/presentation/previous-exports/`.

## Checks completed on 1 November 2026

| Check | Observed result |
| --- | --- |
| Total slides | 10 |
| Notes parts | 10 |
| Native tables | 6, on slides 3, 5, 6, 7, 8 and 9 |
| Source links in notes | 23 occurrences |
| Package integrity | Passed, no findings |
| Declared geometry and layout | Passed, no findings or warnings |
| Font policy | Arial in all 176 checked text scripts |
| First-party import of final bytes | Passed, 10 slides |
| Visual review | All 10 slides rendered from the exported PPTX and inspected individually |

Final file SHA-256: `c72a378b9f28541148d5ab00d471387b9c7e60d1eb574a902ab1153fc32da3d4`.

The private validation receipt is `.codex-finalizer/TaskLatch-CodeQuest-2026.validation.json`. Round-trip previews are in `.build/presentation/final-renders/`. Validation checks package structure, encoded fonts and declared layout. The exported file was rendered with Artifact Tool; it has not been opened in native Microsoft PowerPoint or Google Slides. These checks do not establish prototype correctness, real security effectiveness or model capabilities.

## Regeneration in this workspace

The source uses the bundled JavaScript runtime and libraries discovered for this session. Node is `/Users/Shikhar/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`; packages are under its adjacent `node_modules` directory. The build directory has a symlink to those packages. Do not install replacement presentation libraries.

Before authoring a new revision, choose a new output filename and private receipt filename in the builder, because finalization deliberately refuses to overwrite an existing validated export. Copy the source into `.build/presentation/` for package resolution and run it with the bundled Node from the project root. The builder exports the PPTX, renders authoring previews, creates notes and runs the structural, font, table and import checks. Update the final path in `verify_deck.mjs`, run it from the same project root and review every rendered slide before delivery.

No runtime code for TaskLatch itself has been implemented. The project plan and prototype backlog remain the implementation contract.
