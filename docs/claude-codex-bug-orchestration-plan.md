# Claude + Codex Bug-Orchestration Plan

## Objective

Build a local, resumable bug-search pipeline that runs Claude Opus and Codex independently against the same repository shards, cross-examines their findings, and produces a prioritized report with explicit evidence.

The first milestone is discovery and challenge, not automated fixes. The system must never modify production code during a scan.

This plan is written so either Claude Code or Codex can implement it without relying on prior conversation context.

## Current environment

- Repository: `windows-notch`
- Platform: Windows / PowerShell
- Runtime: Node.js 22
- Codex CLI: `0.146.0`
- Claude Code: `2.1.220`
- Claude plugin: `codex@openai-codex` `1.0.6`
- Default Codex model: `gpt-5.6-sol`
- Claude model for this workflow: `opus`
- Service tier: Standard; leave `service_tier` unset

Resolve both CLIs from `PATH`. Do not hard-code a user-specific installation path in committed code.

## Design principles

1. **Independent discovery:** Claude and Codex must not see each other's findings during the initial scan.
2. **Evidence before fixes:** A finding needs a trigger, exact failure path, and observable impact.
3. **Adversarial validation:** Each provider challenges findings produced by the other provider.
4. **Read-only by default:** Discovery and challenge jobs cannot edit repository files.
5. **Reproducibility:** Every run records the commit SHA, prompts, schemas, CLI versions, and raw output.
6. **Resumability:** Successful jobs are not repeated unless their inputs changed.
7. **Bounded concurrency:** Start with two Claude jobs and two Codex jobs at a time.
8. **No automatic publication:** The system does not create issues, branches, commits, PRs, or external messages.
9. **No automatic fixes in the MVP:** Fixing begins only after a human reviews the report.

## Architecture

```text
frozen commit + shard manifest
        |
        +----> Claude Opus scouts ----+
        |                             |
        +----> Codex scouts ----------+----> normalize and deduplicate
                                              |
                       +----------------------+----------------------+
                       |                                             |
                       v                                             v
             Codex challenges Claude                     Claude challenges Codex
                       |                                             |
                       +----------------------+----------------------+
                                              |
                                              v
                                  promotion and repro queue
                                              |
                                              v
                                      Markdown report
```

The batch coordinator must be a standalone Node.js program. The Claude Codex plugin remains useful for interactive rescue, branch review, and final adversarial review, but it is not the batch scheduler.

## Files to create

```text
debug-orchestrator/
├── README.md
├── manifest.json
├── orchestrate.mjs
├── lib/
│   ├── cli.mjs
│   ├── queue.mjs
│   ├── run-store.mjs
│   ├── normalize.mjs
│   ├── dedupe.mjs
│   ├── report.mjs
│   └── providers/
│       ├── claude.mjs
│       └── codex.mjs
├── prompts/
│   ├── scout.md
│   ├── challenge.md
│   └── reproduce.md
├── schemas/
│   ├── findings.schema.json
│   ├── verdicts.schema.json
│   └── reproduction.schema.json
└── test/
    ├── fixtures/
    ├── queue.test.mjs
    ├── normalize.test.mjs
    └── dedupe.test.mjs

.debug-runs/                 # generated, gitignored
```

Add `.debug-runs/` to `.gitignore`. Do not commit raw model output or temporary worktrees.

Use Node built-ins for the MVP. Avoid adding a database or framework. JSON, JSONL, `child_process`, `crypto`, `fs`, and `path` are sufficient.

## Package scripts

Add these scripts to the root `package.json`:

```json
{
  "bugs:preflight": "node debug-orchestrator/orchestrate.mjs preflight",
  "bugs:scan": "node debug-orchestrator/orchestrate.mjs scan",
  "bugs:resume": "node debug-orchestrator/orchestrate.mjs resume",
  "bugs:report": "node debug-orchestrator/orchestrate.mjs report",
  "bugs:test": "node --test debug-orchestrator/test/*.test.mjs"
}
```

Expected usage:

```powershell
npm run bugs:preflight
npm run bugs:scan -- --shard main-lifecycle
npm run bugs:scan
npm run bugs:resume -- --run <run-id>
npm run bugs:report -- --run <run-id>
```

CLI behavior:

- `scan` creates a new run and executes both providers by default.
- `scan --provider claude|codex` is available for adapter smoke tests, but a provider-specific run is not considered a complete discovery run.
- `scan --shard <id>` limits the new run to one shard.
- `resume --run <id>` reopens an existing run and executes only missing, failed, timed-out, or invalidated jobs.
- `report --run <id>` regenerates the report from stored normalized data without making model calls.
- `report --latest` selects the most recently created run.
- Unknown commands, flags, providers, or shard IDs fail with a nonzero exit code and concise usage text.

## Initial shard manifest

Create `debug-orchestrator/manifest.json`:

```json
{
  "version": 1,
  "concurrency": {
    "claude": 2,
    "codex": 2
  },
  "timeoutsMinutes": {
    "scout": 30,
    "challenge": 20,
    "reproduce": 30
  },
  "providers": {
    "claude": {
      "model": "opus",
      "effort": "high",
      "maxBudgetUsdPerJob": 3
    },
    "codex": {
      "model": "gpt-5.6-sol"
    }
  },
  "shards": [
    {
      "id": "main-lifecycle",
      "description": "Electron lifecycle, windows, sessions, focus, settings, tray, and usage state",
      "paths": [
        "src/main/index.ts",
        "src/main/windows.ts",
        "src/main/sessionWatcher.ts",
        "src/main/focus.ts",
        "src/main/settings.ts",
        "src/main/tray.ts",
        "src/main/usage.ts",
        "src/shared/types.ts"
      ]
    },
    {
      "id": "hooks-dispatch-ipc",
      "description": "Hook ingestion, installation, dispatch, managed Codex, preload, and trust boundaries",
      "paths": [
        "src/main/hookServer.ts",
        "src/main/hookInstaller.ts",
        "src/main/dispatcher.ts",
        "src/main/managedCodex.ts",
        "src/preload/index.ts",
        "src/shared/types.ts"
      ]
    },
    {
      "id": "desktop-renderer",
      "description": "React state, status transitions, formatting, hit targets, and desktop interactions",
      "paths": [
        "src/renderer",
        "src/shared/types.ts"
      ]
    },
    {
      "id": "mobile-bridge",
      "description": "Desktop/mobile bridge protocol, reconnection, synchronization, and mobile UI",
      "paths": [
        "src/main/mobileBridge.ts",
        "mobile/src",
        "src/shared/types.ts"
      ]
    },
    {
      "id": "automation-packaging",
      "description": "Verification scripts, hook management, build configuration, packaging, and recovery behavior",
      "paths": [
        "scripts",
        "package.json",
        "mobile/package.json",
        "electron.vite.config.ts",
        "tsconfig.json",
        "tsconfig.node.json",
        "tsconfig.web.json"
      ]
    }
  ]
}
```

Intentional overlap is allowed for protocol and boundary files such as `src/shared/types.ts`.

## Preflight contract

`npm run bugs:preflight` must:

1. Resolve `codex`, `claude`, `git`, `node`, and `npm` from `PATH`.
2. Capture:
   - `codex --version`
   - `claude --version`
   - `node --version`
   - `git --version`
3. Require Codex `>= 0.146.0`.
4. Require Claude Code `>= 2.1.217`, because budget enforcement for background subagents is reliable from that version onward.
5. Confirm that `claude plugin list` shows `codex@openai-codex` enabled. This is informational for batch mode, not a hard dependency.
6. Confirm the repository is a Git worktree.
7. Capture `git rev-parse HEAD`.
8. Fail if `git status --porcelain` is non-empty. Add `--allow-dirty` later; do not include it in the MVP.
9. Confirm every manifest path exists.
10. Run the existing deterministic baseline:

```powershell
npm run typecheck
npm run verify
npm run test:status-flash
npm run test:pill-geometry
npm run test:interactions
```

Record baseline failures separately. A pre-existing failing test is not automatically an LLM-discovered bug.

The preflight command must not make paid model calls.

## Run storage

Each run lives under:

```text
.debug-runs/<run-id>/
├── run.json
├── jobs.jsonl
├── baseline/
├── prompts/
├── raw/
│   ├── claude/
│   └── codex/
├── normalized/
│   ├── claude/
│   └── codex/
├── candidates.json
├── verdicts.json
└── report.md
```

Use a run ID formatted as:

```text
YYYYMMDD-HHMMSS-<short-commit>
```

`run.json` must include:

- run ID
- UTC start and finish timestamps
- commit SHA
- CLI versions
- manifest hash
- schema hashes
- prompt hashes
- configuration
- aggregate counts
- run status

Every job record must include:

- stable job ID
- provider
- phase
- shard
- status: `pending`, `running`, `succeeded`, `failed`, `timed_out`, or `skipped`
- command excluding secrets
- start and finish timestamps
- exit code
- output paths
- input hash
- error summary

Write state atomically: write a temporary file beside the destination, then rename it.

## Provider adapter contract

Both provider adapters expose:

```js
async function runJob({
  repoRoot,
  prompt,
  schemaPath,
  rawOutputPath,
  rawErrorPath,
  normalizedOutputPath,
  timeoutMs,
  modelConfig
}) {
  // returns { status, exitCode, data, metadata }
}
```

The adapter must:

1. Spawn the CLI without a shell when possible.
2. Send the prompt through stdin.
3. Capture stdout and stderr separately.
4. Stream raw logs to disk to avoid keeping large output in memory.
5. enforce a timeout;
6. terminate only the exact spawned process tree on timeout.
7. parse structured output.
8. reject malformed or schema-incompatible results.
9. never silently convert an error into an empty successful result.

Do not log authentication tokens or full environment variables.

### Codex command

Use:

```powershell
codex exec `
  --ephemeral `
  --strict-config `
  --model gpt-5.6-sol `
  --cd <repo-root> `
  --sandbox read-only `
  --output-schema <schema-path> `
  --output-last-message <result-path> `
  -
```

Rules:

- Leave `service_tier` unset so Standard processing is used.
- Do not use `--dangerously-bypass-approvals-and-sandbox`.
- The file written by `--output-last-message` is the structured result.
- stderr is progress/debugging information and must not be parsed as the finding payload.

### Claude command

Use:

```powershell
claude -p `
  --model opus `
  --effort high `
  --permission-mode plan `
  --tools "Read,Glob,Grep" `
  --output-format json `
  --json-schema <schema-json> `
  --max-budget-usd 3 `
  --no-session-persistence
```

Rules:

- Pass the schema contents, not only the schema path, to `--json-schema`.
- Do not expose `Write`, `Edit`, or unrestricted `Bash` during discovery or challenge.
- Preserve the complete JSON envelope as raw output.
- Normalize the validated structured object from the envelope.
- If the expected structured field is absent, fail the job and retain the raw response for diagnosis.

## Finding schema

`findings.schema.json` represents one provider's findings for one shard:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["shard_id", "findings", "residual_risks"],
  "properties": {
    "shard_id": {
      "type": "string"
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "title",
          "severity",
          "confidence",
          "category",
          "file",
          "symbol",
          "line_start",
          "line_end",
          "preconditions",
          "failure_path",
          "observable_impact",
          "evidence",
          "suggested_test",
          "false_positive_risk"
        ],
        "properties": {
          "title": { "type": "string", "minLength": 1 },
          "severity": {
            "type": "string",
            "enum": ["P0", "P1", "P2", "P3"]
          },
          "confidence": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "category": { "type": "string", "minLength": 1 },
          "file": { "type": "string", "minLength": 1 },
          "symbol": { "type": "string", "minLength": 1 },
          "line_start": { "type": "integer", "minimum": 1 },
          "line_end": { "type": "integer", "minimum": 1 },
          "preconditions": {
            "type": "array",
            "minItems": 1,
            "items": { "type": "string" }
          },
          "failure_path": { "type": "string", "minLength": 1 },
          "observable_impact": { "type": "string", "minLength": 1 },
          "evidence": {
            "type": "array",
            "minItems": 1,
            "items": { "type": "string" }
          },
          "repro_command": {
            "type": ["string", "null"]
          },
          "suggested_test": { "type": "string", "minLength": 1 },
          "false_positive_risk": { "type": "string", "minLength": 1 }
        }
      }
    },
    "residual_risks": {
      "type": "array",
      "items": { "type": "string" }
    }
  }
}
```

The implementation may store provider and shard metadata outside individual findings. Do not ask the model to generate globally unique IDs.

## Scout prompt

`prompts/scout.md`:

```text
You are performing a read-only correctness audit of one repository shard.

Repository commit: {{COMMIT_SHA}}
Shard ID: {{SHARD_ID}}
Shard description: {{SHARD_DESCRIPTION}}
Allowed paths:
{{SHARD_PATHS}}

Inspect only the supplied shard and the minimum directly referenced boundary
code needed to validate a claim.

Find externally observable correctness bugs, not style issues, speculative
hardening, missing comments, or general refactoring opportunities.

For every candidate:
1. Identify concrete triggering preconditions.
2. Trace the exact code path and faulty state transition.
3. State the observable incorrect behavior and user/system impact.
4. Cite specific files, symbols, line ranges, guards, assignments, or callers.
5. Search actively for cleanup paths, validation, callers, tests, or invariants
   that disprove the candidate.
6. Describe the strongest false-positive risk.
7. Suggest a minimal test that would reproduce the behavior.

Omit candidates below 0.65 confidence.
Do not edit files.
Do not propose implementation fixes.
Do not include style, maintainability, or performance observations unless they
produce a concrete correctness failure.

Return only data matching the supplied JSON schema.
```

Generate a provider-specific prompt file for every job and save it under the run directory before launching the provider.

## Candidate normalization and IDs

After all scout jobs finish:

1. Normalize path separators to `/`.
2. Confirm cited files exist.
3. Confirm line ranges are valid and `line_end >= line_start`.
4. Trim strings and remove empty evidence entries.
5. Reject findings below `0.65` confidence.
6. Attach provider, shard, job ID, and run ID.
7. Generate a deterministic candidate ID using SHA-256 over:

```text
normalized category
normalized file
normalized symbol
normalized failure_path
```

Use the first 12 hexadecimal characters for display, but retain the full hash internally.

## Deduplication

MVP deduplication is deterministic:

1. Exact candidate hash match: merge.
2. Same normalized file and symbol with overlapping line ranges: mark as possible duplicate.
3. Same normalized file and category with similar normalized title tokens: mark as possible duplicate.
4. Never automatically merge findings from different symbols solely because their titles are similar.

For merged findings:

- preserve every provider's original evidence;
- retain the highest severity;
- retain provider-specific confidence values;
- record all originating shards and job IDs.

Possible duplicates remain separate in the raw candidate set and are grouped in the report.

Do not use either LLM for initial deduplication in the MVP.

## Challenge phase

Each provider challenges only findings originating from the other provider:

- Codex challenges Claude findings.
- Claude challenges Codex findings.
- Findings independently discovered by both providers still receive one challenge pass, but the challenger must be told that independent discovery occurred only after it completes its own code inspection.

Batch no more than ten findings into one challenge job. Include only the cited paths and minimal neighboring boundary files.

`prompts/challenge.md`:

```text
You are an adversarial reviewer. Your task is to falsify candidate bug reports,
not to defend them.

Repository commit: {{COMMIT_SHA}}
Candidates:
{{CANDIDATES_JSON}}

For each candidate:
1. Inspect the cited code and relevant callers.
2. Look for guards, validation, cleanup, ordering constraints, retries, tests,
   platform behavior, or unreachable preconditions that invalidate the claim.
3. Decide exactly one verdict:
   - confirmed
   - rejected
   - needs_reproduction
4. State the strongest evidence for the verdict.
5. If confirmed, restate the complete trigger-to-impact path.
6. If rejected, identify the exact fact that breaks the proposed path.
7. If reproduction is needed, specify the smallest deterministic experiment.

A plausible explanation is not confirmation.
Do not edit files.
Do not propose fixes.
Return only data matching the supplied JSON schema.
```

## Verdict schema

Every verdict contains:

- candidate ID
- verdict: `confirmed`, `rejected`, or `needs_reproduction`
- challenger provider
- rationale
- supporting evidence
- invalidating evidence
- minimal reproduction
- confidence from `0` to `1`

Reject a challenge response that omits a candidate ID or returns multiple verdicts for one candidate.

## Promotion policy

Classify the union of scout and challenge results:

### Verified

A candidate is `verified` when:

- a deterministic reproduction or failing test exists; or
- both providers independently identify the same root cause and the challenge pass confirms the complete failure path.

### Probable

A candidate is `probable` when:

- one provider finds it;
- the other provider confirms the code path;
- no executable reproduction exists yet.

### Needs reproduction

A candidate is `needs_reproduction` when:

- the code path is plausible;
- the challenger cannot prove or disprove a runtime assumption.

### Rejected

A candidate is `rejected` when:

- the challenger identifies a guard, invariant, cleanup path, impossible precondition, or incorrect platform assumption that breaks the failure path.

P0 and P1 findings must not be called verified without executable evidence or unusually strong independent agreement with exact code-path proof.

## Reproduction phase

Implement reproduction only after the discovery/challenge MVP is working.

For each selected candidate:

1. Create a dedicated Git worktree outside the main working directory.
2. Use the provider that did not originate the finding when possible.
3. Permit writes only inside that worktree.
4. Ask the worker to add or modify tests only.
5. Prohibit production-code changes.
6. Capture:
   - exact command;
   - exit code;
   - relevant stdout/stderr;
   - test file changes;
   - whether the test failed for the predicted reason.
7. Delete or retain the worktree only through an explicit cleanup command after report generation.

`prompts/reproduce.md`:

```text
Create the smallest deterministic failing test for the supplied candidate.

You may edit test files and test-only fixtures in this isolated worktree.
Do not modify production code.
Do not fix the bug.
Do not weaken existing assertions.

Run the narrowest relevant command and report whether the failure matches the
candidate's predicted failure path.

If reproduction is impossible, explain the exact missing prerequisite or
incorrect assumption. Return only data matching the supplied JSON schema.
```

## Report contract

Generate `.debug-runs/<run-id>/report.md` with:

1. Run metadata
2. Baseline status
3. Executive summary
4. Verified findings
5. Probable findings
6. Findings needing reproduction
7. Rejected findings
8. Residual risks by shard
9. Failed or timed-out jobs
10. Recommended next actions

Each promoted finding must show:

- candidate ID
- title
- severity
- status
- origin provider
- challenger provider and verdict
- confidence values
- file, symbol, and line range
- preconditions
- failure path
- observable impact
- evidence
- proposed reproduction
- false-positive risk

Do not hide rejected findings; keep them in an appendix so the run remains auditable.

## Resumability

Compute an input hash for each job from:

- commit SHA
- provider and model configuration
- phase
- shard or candidate batch
- prompt contents
- schema contents

On `resume`:

- skip a succeeded job when its input hash matches and its normalized output still parses;
- rerun failed or timed-out jobs;
- rerun any job whose inputs changed;
- never treat a raw-output file alone as proof of success;
- regenerate aggregate candidates, verdicts, and the report after resumed work.

## Queue behavior

- Maintain independent concurrency counters for Claude and Codex.
- Default to two jobs per provider.
- Start jobs in shard order for reproducible logs.
- A provider failure must not cancel successful jobs from the other provider.
- Retry transient process or provider failures once with a short randomized delay.
- Do not retry schema-invalid output automatically more than once.
- Exit nonzero when any required scout job remains failed after retries.
- Still generate a partial report when possible.

## Tests

Implement provider fixtures so most tests do not make model calls.

Required automated tests:

1. Queue enforces per-provider concurrency.
2. Successful jobs are skipped on resume.
3. Changed prompt or schema invalidates a cached job.
4. Timeout marks only the target job as timed out.
5. Malformed output fails normalization.
6. Duplicate hashes merge while preserving provenance.
7. Similar titles in different symbols are not merged.
8. Report includes failed jobs and rejected findings.
9. Atomic state writes do not leave a partially written canonical file.
10. Scan commands never expose write-capable flags.

Run:

```powershell
npm run bugs:test
npm run typecheck
npm run verify
```

## MVP implementation order

Implement in this order:

### Milestone 1: scaffold and preflight

- [ ] Create directories and manifest.
- [ ] Add package scripts.
- [ ] Add `.debug-runs/` to `.gitignore`.
- [ ] Implement CLI argument parsing.
- [ ] Implement version, Git, manifest, and baseline checks.
- [ ] Add unit tests for argument and manifest validation.

### Milestone 2: independent scouts

- [ ] Add the findings schema and scout prompt.
- [ ] Implement the Codex provider adapter.
- [ ] Implement the Claude provider adapter.
- [ ] Implement independent provider queues.
- [ ] Store raw and normalized results.
- [ ] Implement retry, timeout, and failure records.
- [ ] Run a live one-shard smoke test with one provider at a time.
- [ ] Run one shard with both providers and confirm neither sees the other's output.

At the end of Milestone 2, the repository can begin useful bug searching.

### Milestone 3: normalize, deduplicate, and report

- [ ] Implement candidate normalization and deterministic IDs.
- [ ] Implement deterministic deduplication.
- [ ] Implement the first Markdown report.
- [ ] Verify a full five-shard discovery run can resume.

### Milestone 4: cross-provider challenge

- [ ] Add the verdict schema and challenge prompt.
- [ ] Batch at most ten candidates per challenge job.
- [ ] Route candidates only to the opposing provider.
- [ ] Implement promotion policy.
- [ ] Expand the report with verdicts and rejected findings.

At the end of Milestone 4, the system produces a reviewable high-confidence bug backlog.

### Milestone 5: reproduction

- [ ] Add isolated worktree management.
- [ ] Add test-only write permissions.
- [ ] Implement the reproduction schema and adapter mode.
- [ ] Capture commands, outputs, and test diffs.
- [ ] Promote reproducible findings to verified.

### Milestone 6: optional fix workflow

- [ ] Require explicit human selection of candidate IDs.
- [ ] Create one worktree and branch per selected bug.
- [ ] Assign implementation to one provider.
- [ ] Assign patch review to the other provider.
- [ ] Run existing repository checks.
- [ ] Never commit or publish without explicit instruction.

## First live run

Do not start with all five shards.

1. Ensure the worktree is clean.
2. Run preflight.
3. Run unit tests.
4. Run only `hooks-dispatch-ipc` with Codex.
5. Run the same shard with Claude.
6. Inspect both raw and normalized outputs.
7. Confirm the source worktree is unchanged.
8. Run the dedupe/report step.
9. Enable challenge mode for that shard.
10. Fix any orchestration defects before the full scan.

Commands:

```powershell
npm run bugs:preflight
npm run bugs:test
npm run bugs:scan -- --shard hooks-dispatch-ipc
npm run bugs:report -- --latest
git status --short
```

After the pilot succeeds:

```powershell
npm run bugs:scan
npm run bugs:report -- --latest
```

## Interactive Claude plugin usage

Keep the existing `codex@openai-codex` plugin enabled for targeted work outside the batch pipeline.

Useful Claude Code commands:

```text
/codex:setup
/codex:setup --enable-review-gate
/codex:rescue --wait --fresh <read-only diagnosis request>
/codex:adversarial-review --background --scope branch --base main <focus>
/codex:status
/codex:result <job-id>
```

Use `/codex:rescue` for one substantial diagnosis or implementation handoff. Use `/codex:adversarial-review` for a Git diff or branch. Do not use the plugin's single-job rescue path as the batch scheduler.

## Safety requirements

- Never use `danger-full-access` during discovery or challenge.
- Never use Claude's `bypassPermissions` mode.
- Never commit credentials or copy auth files into the repository.
- Never print full process environments.
- Treat raw model output as potentially sensitive and keep `.debug-runs/` ignored.
- Require a clean Git worktree for the MVP.
- Record every command and exit code.
- Preserve raw output when parsing fails.
- Do not auto-fix findings during discovery.
- Do not create external issues or PRs.
- Do not run untrusted repository scripts in the same process environment as API keys.

## Definition of done

The orchestration MVP is complete when:

1. Preflight passes on Windows.
2. Both CLIs can scan one shard independently with schema-valid output.
3. A full five-shard discovery run is bounded to configured concurrency.
4. Interrupted runs resume without repeating successful jobs.
5. Every candidate retains raw provenance and normalized evidence.
6. Cross-provider challenges generate one verdict per candidate.
7. The report separates verified, probable, needs-reproduction, and rejected findings.
8. The source worktree remains unchanged after discovery and challenge.
9. Unit tests and existing repository verification commands pass.
10. A human can choose a candidate ID and understand exactly how to reproduce it.
