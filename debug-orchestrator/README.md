# debug-orchestrator

A local, resumable bug-search pipeline. It runs **two independent dispatch
tracks** in parallel — Claude finds and Codex verifies; Codex finds and Claude
verifies — compares what the two tracks concluded, resolves their disagreements,
and produces a prioritized Markdown report with explicit evidence.

**`scan` never modifies the repository.** Discovery, challenge, and tiebreak jobs
run with read-only tooling, and every run verifies the worktree is unchanged when
it finishes. Fixing is a separate, human-initiated command.

It is not specific to any project — point it at any git repository with a
manifest describing that repository's shards.

## ⚠️ This costs real money

Every `scan` spawns paid model calls: one scout job per (shard × provider), then
challenge jobs on top. With the default `maxBudgetUsdPerJob: 3` and five shards,
a full run can reach tens of dollars. Start with `--shard <id>` on one shard to
see what a run costs you before scanning everything.

`preflight`, `report`, and the unit tests make **no** model calls.

## Requirements

- Node 22+
- [Claude Code](https://claude.com/claude-code) (`claude`) and the Codex CLI
  (`codex`), both on `PATH`
- A git repository with a clean working tree
- Windows, macOS, or Linux. Process spawning, PATH resolution, and process-tree
  termination are all platform-aware.

No third-party npm dependencies: Node built-ins only.

## Install

Vendor it into your repository (what this project does):

```bash
git clone https://github.com/osaini/notch.git /tmp/wn
cp -r /tmp/wn/debug-orchestrator ./debug-orchestrator
echo ".debug-runs/" >> .gitignore
```

Or keep it anywhere and point it at a repository with `--repo-root`. The tool
finds the repository by running `git rev-parse --show-toplevel` in the current
directory, so it does not care where it lives.

Optionally add scripts to your own `package.json` — any prefix works, and the
tool echoes your names back in its hints:

```json
{
  "scripts": {
    "bugs:preflight": "node debug-orchestrator/orchestrate.mjs preflight",
    "bugs:scan": "node debug-orchestrator/orchestrate.mjs scan",
    "bugs:resume": "node debug-orchestrator/orchestrate.mjs resume",
    "bugs:report": "node debug-orchestrator/orchestrate.mjs report",
    "bugs:implement": "node debug-orchestrator/orchestrate.mjs implement",
    "bugs:test": "node --test debug-orchestrator/test/*.test.mjs"
  }
}
```

## Configure

Copy [`manifest.example.json`](manifest.example.json) to
`debug-orchestrator.json` in your repository root and edit it. Only `shards` has
no useful default.

| Field | Default | What it does |
| --- | --- | --- |
| `shards` | `[]` (required) | Slices of the codebase to scout, one job each. `{ id, description, paths }`. Keep each one small enough for a model to hold at once. |
| `baseline` | `[]` | Deterministic checks that mean "still healthy". `{ name, args }` runs under `packageManager`; add `command` to run something else verbatim. Empty means no baseline. |
| `packageManager` | `"npm"` | What `baseline` entries without an explicit `command` run under. |
| `concurrency` | `{ claude: 2, codex: 2 }` | Jobs in flight per provider. |
| `timeoutsMinutes` | 20–30 per phase | Per-phase wall clock. |
| `providers` | Opus / gpt-5.6-sol | Model, effort, and per-job budget. |
| `minimumVersions` | `{ claude: null, codex: null }` | Advisory CLI floors. Reported as warnings, never fatal. |
| `requiredClaudePlugins` | `[]` | Plugins to report on in preflight. Informational. |

Resolution order: `--manifest <path>` → `<repo-root>/debug-orchestrator.json` →
the bundled `manifest.json`, if you prefer to edit in place.

A shard's `paths` are checked to exist during preflight, and are rendered into
the scout prompt. They do not restrict what the model may read.

## Commands

```bash
node debug-orchestrator/orchestrate.mjs preflight               # tooling, git, manifest, baseline (no model calls)
node debug-orchestrator/orchestrate.mjs scan --shard core       # both tracks over one shard
node debug-orchestrator/orchestrate.mjs scan                    # every shard
node debug-orchestrator/orchestrate.mjs resume --run <run-id>   # re-run only outstanding jobs
node debug-orchestrator/orchestrate.mjs report --latest         # regenerate the report from stored data
node debug-orchestrator/orchestrate.mjs fix --latest --max-fixes 1  # plan and implement a capped batch of verified findings
node debug-orchestrator/orchestrate.mjs implement --task "..."  # plan/critique/implement/review one task in a worktree
node debug-orchestrator/orchestrate.mjs fix --clean <run-id>    # remove a run's worktree and branch
node --test debug-orchestrator/test/*.test.mjs                  # unit tests (no model calls)
```

`--repo-root <path>` and `--manifest <path>` work on every command.

**`fix` and `implement` are the only commands that write code**, and only inside
their own git worktree under `.debug-runs/<run-id>/tree` on a throwaway
`debug-impl/<run-id>` branch. Your checkout and your branches are never touched.
A `fix` batch commits *inside that worktree* between fixes so each fix's diff
covers only its own work; `--clean` deletes the branch and tree wholesale.

`scan --provider claude|codex` runs a single provider. That is an adapter smoke
test only: one provider cannot form a track (there is nobody to verify its
findings), so the challenge phase is skipped and the run is recorded as
incomplete discovery.

Unknown commands, flags, providers, and shard ids exit nonzero with usage text.

## How a run works

```text
frozen commit + shard manifest
        |
        +----> Claude scouts ----> Track A candidates ----> Codex verifies ----+
        |                                                                      |
        +----> Codex scouts -----> Track B candidates ----> Claude verifies ---+
                                                                               |
                                    (both tracks run concurrently)             |
                                                                               v
                                                                    compare the two tracks
                                                                               |
                                                          disputes ------------+
                                                             |                 |
                                                             v                 |
                                                     tiebreak round -----------+
                                                                               |
                                                                               v
                                                                  promotion and repro queue
                                                                               |
                                                                               v
                                                                       Markdown report
                                                                               |
                                                            GATE — nothing writes code until
                                                                    someone runs `bugs:fix`
```

1. **Scout.** One job per (provider, shard). Neither provider sees the other's
   output. Findings below 0.65 confidence are discarded.
2. **Normalize.** Paths are normalized, cited files and line ranges are checked
   against the real tree, and each finding gets a deterministic candidate id:
   `sha256(category, file, symbol, failure_path)`.
3. **Deduplicate.** Deterministic, no model involved. Each track dedupes its own
   finder's candidates. Identical hashes merge; overlapping ranges and similar
   titles are only *flagged* for human review.
4. **Challenge.** Each track's findings go to that track's opposing provider, at
   most ten per job. A candidate *both* finders produced is therefore verified
   twice, once per track — that second verdict is what makes the tracks
   comparable at all. The payload strips provider identity and scout confidence,
   so a verifier judges the code rather than the claimant. Track A's jobs are all
   Codex and Track B's all Claude, so the queue's per-provider lanes run the two
   tracks in parallel.
5. **Compare.** Deterministic, no model involved. Joins the tracks on candidate
   id and records what each found and concluded: `both-confirmed`,
   `both-rejected`, `disputed`, `single-confirmed`, `single-rejected`, or
   `unresolved`. Written to `comparison.json`.
6. **Tiebreak.** Only for `disputed` — one track's verifier confirmed the failure
   path and the other's rejected it. Both positions are re-presented anonymously
   as `assessment_1`/`assessment_2`, ordered by the hash of their text so neither
   position nor provider identity leaks, and the tiebreaker re-inspects the code.
   A confirmed/`needs_reproduction` split is *not* a dispute and never buys a
   tiebreak job.
7. **Promote.** Verified / probable / disputed / needs reproduction / rejected.
   `verified` now means both tracks found it **and** both verifiers confirmed it.
8. **Report.** `report.md` in the run directory.

## Fixing

`bugs:fix` is the second, code-writing half, deliberately behind a gate.

Only `verified` findings are eligible — both tracks found it and both verifiers
confirmed it. A finding that survived only because a tiebreak resolved a
contradiction is excluded unless you pass `--include-tiebroken`: two models
actively disagreeing about whether a bug is real is a poor premise for an
unattended code change. The batch is capped by `--max-fixes` (default 5).

One planning call orders the whole batch, grouping fixes that touch the same file
and flagging ones that interact. Then each fix runs the full
plan → critique → implement → review loop, **sequentially, in one shared
worktree**, so each fix's baseline run validates the accumulated state and a fix
that breaks an earlier one is caught here rather than at merge time.

Between fixes the worktree is committed (on acceptance) or reset (on failure), so
no fix's diff ever contains another's work. A failed fix does not abort the
batch, and its rounds stay on disk under `fixes/<index>/` even after the reset.

## Run storage

Runs live under `.debug-runs/<run-id>/` (gitignored; raw model output is treated
as potentially sensitive). Run ids are `YYYYMMDD-HHMMSS-<short-commit>`.

```text
.debug-runs/<run-id>/
├── run.json          # commit, CLI versions, manifest/prompt/schema hashes, config, counts, status
├── jobs.jsonl        # append-only job log; the last record per job id wins
├── baseline/         # preflight snapshot for this commit
├── prompts/          # the exact prompt sent for every job
├── raw/<provider>/   # stdout, stderr, and Codex's structured result file
├── normalized/       # schema-validated, normalized job output
├── candidates.json   # deduplicated candidates, plus each track's own candidate set
├── verdicts.json     # verdicts, keyed by (track, candidate) — a shared candidate has two
├── comparison.json   # cross-track agreement, per candidate, plus any tiebreak
├── fix-plan.json     # fix runs only: the planner's ordering for the batch
├── fixes/<index>/    # fix runs only: per-fix rounds, diffs, baselines
├── tree/             # fix/implement runs only: the isolated worktree
└── report.md
```

`.debug-runs/preflight/<commit>.json` holds the baseline captured by
`preflight`; `scan` copies the matching one into the run.

**Add `.debug-runs/` to your repository's `.gitignore`.** It holds raw model
output, which should be treated as potentially sensitive.

## Resumability

Each job carries an input hash over the commit, provider and model config, phase,
track, shard or candidate batch, prompt contents, and schema contents. The track
is part of the key: the same candidate batch judged for the other track is a
different job with a different answer. On `resume` a job
is skipped only when its recorded status is `succeeded`, its input hash matches,
**and** its normalized output still parses. A raw output file is never treated as
proof of success. Failed and timed-out jobs always re-run; changing a prompt or a
schema invalidates every job built from it.

## Safety

- Codex runs `--sandbox read-only`; `danger-full-access` and
  `--dangerously-bypass-approvals-and-sandbox` are rejected before spawn.
- Claude runs `--permission-mode plan` with `--tools Read,Glob,Grep`; `Write`,
  `Edit`, and `Bash` are rejected before spawn.
- `lib/providers/safety.mjs` asserts both command lines on every job, and a unit
  test asserts the assertion works.
- A clean worktree is required. `--allow-dirty` is deliberately not implemented.
- The recorded argv redacts the inline JSON schema; environments and tokens are
  never logged.
- Nothing is pushed or published. No issues or PRs. The only commits a run can
  make are inside its own `.debug-runs/<run-id>/tree` worktree, on the throwaway
  `debug-impl/<run-id>` branch, and only during a multi-fix `bugs:fix` batch.
  Your checkout and your branches are never written to.
- `resetWorktree` runs `git clean` without `-x`, so ignored files survive. That
  is what keeps the `node_modules` junction intact — removing it would follow the
  link and delete the repository's real dependencies.

## Deviations from the plan

Three, each deliberate:

1. **`repro_command` is in the findings schema's `required` list.** Provider
   structured-output modes require every declared property to be required;
   optionality is expressed by its `["string", "null"]` type instead.
2. **Provider-facing schemas are a projection of the canonical ones.**
   `toProviderSchema` strips value constraints (`minLength`, `minItems`,
   `minimum`, `maximum`) that structured-output modes reject, and writes the
   result to `<run>/schemas/*.provider.json`. The canonical schema in
   `schemas/` stays authoritative: every response is validated against it, and
   the stripped constraints are re-enforced during normalization. Prompts state
   the constraints in prose so the models still see them.
3. **`--strict-config` is included only when the installed Codex supports it.**
   It does not exist before Codex 0.146.0. The adapter probes `codex exec --help`
   so an older CLI degrades with a recorded warning instead of failing every job
   on an argument parse error.

## Known limitations

- **`implement` requires a Node project for dependency linking.** `linkDependencies`
  only ever links `node_modules` into the worktree. Other ecosystems get
  `strategy: 'absent'`, so baseline commands needing installed dependencies will
  fail there. Use `--skip-baseline`, or install dependencies in the worktree.
- **Shallow clones and submodule-heavy repositories** may not support the
  `git worktree add` that `implement` depends on. Discovery is unaffected.

## Not yet implemented

Milestone 5 (reproduction in isolated worktrees). `prompts/reproduce.md` and
`schemas/reproduction.schema.json` exist and the promotion policy already honors
reproduction results, but no reproduction jobs are scheduled yet. Until then
nothing reaches `verified` through executable evidence — only through
cross-track agreement plus two confirmed challenges.

Milestone 6 superseded: the fix workflow shipped as `implement`, with a review
*loop* rather than the single implement-then-review pass the original milestone
described.

## Layout

| File | Responsibility |
| --- | --- |
| `orchestrate.mjs` | CLI entry point and the `preflight` command |
| `lib/cli.mjs` | Argument parsing, usage text, error types |
| `lib/config.mjs` | Repository and manifest resolution, manifest defaults |
| `lib/pipeline.mjs` | Run lifecycle, job construction, phase execution |
| `lib/queue.mjs` | Per-provider bounded concurrency and retry |
| `lib/run-store.mjs` | Run directory layout and atomic state writes |
| `lib/tracks.mjs` | The two dispatch tracks and their finder/verifier pairing |
| `lib/normalize.mjs` | Candidate/verdict/tiebreak normalization and candidate ids |
| `lib/dedupe.mjs` | Deterministic deduplication |
| `lib/payload.mjs` | The identity-stripped candidate payload reviewers see |
| `lib/compare.mjs` | Cross-track join and agreement classification (no model calls) |
| `lib/tiebreak.mjs` | Dispute resolution: anonymized assessments, tiebreaker assignment |
| `lib/promote.mjs` | Promotion policy |
| `lib/fix.mjs` | Fix batch: selection, cap, planner ordering, sequential execution |
| `lib/report.mjs` | Markdown report |
| `lib/preflight.mjs` | Version, git, manifest, and baseline checks |
| `lib/validate.mjs` | Bundled JSON Schema subset validator |
| `lib/proc.mjs` | Command resolution, spawning, timeouts, tree kill |
| `lib/implement.mjs` | Adversarial implement pipeline: phase graph, convergence, stop conditions |
| `lib/worktree.mjs` | Per-run git worktree, dependency linking, diff capture, teardown |
| `lib/providers/*` | Codex and Claude adapters, plus the read-only and write-scope guards |

## License

MIT, same as the repository it ships in.
