# Adversarial planning + implementation pipeline

**Status: implemented.** `npm run bugs:implement`. See `debug-orchestrator/lib/implement.mjs`
and `lib/worktree.mjs`; tests in `test/implement.test.mjs`.

Deviations from the original design are recorded at the end.

A companion to `debug-orchestrator`'s scan pipeline. Where scan *finds* bugs by
having two providers cross-examine each other's findings, this pipeline *ships a
change* by having one provider implement it and the other attack the result,
round by round, until the reviewer stops finding real problems or the round cap
is hit.

This supersedes Milestone 6 of `docs/claude-codex-bug-orchestration-plan.md`,
which sketched a single implement-then-review pass. The difference is the loop:
one review pass produces a critique, not a converged change.

**It writes code — that is the point — but only inside a dedicated git worktree,
never the user's tree, and it never commits, pushes, or opens anything.**

## Phase graph

```text
task (a candidate id from a scan run, or a free-form task)
        |
        v
  [1] plan          implementer drafts an approach       (read-only)
        |
        v
  [2] critique      reviewer attacks the plan            (read-only)
        |
        v
  [3] revise-plan   implementer answers or concedes      (read-only)
        |
        v
  [4] implement     implementer edits the worktree       (write, sandboxed)
        |
        v
  [5] review        reviewer attacks the diff            (read-only)
        |
        +--> accepted, or round cap ----> [7] verify
        |
        v
  [6] revise-code   implementer responds to the review   (write, sandboxed)
        |
        +--> back to [5]
```

Phases 1–3 run once. Phases 5–6 loop. Planning is separated from implementation
deliberately: a reviewer that only ever sees finished code argues about
details, and the expensive disagreements are about approach.

### Convergence and stop conditions

The loop ends when any of these is true, checked in order:

1. **Reviewer accepts** — a `review` job returns no findings at `blocking`
   severity.
2. **Round cap** — `maxReviewRounds` (default 3) is reached. The run ends
   `unconverged`; the diff is kept and reported, never discarded.
3. **Baseline fails twice** — `verify` fails on two consecutive rounds with the
   same failing command. Two identical failures mean the implementer is not
   converging, and further rounds burn budget.
4. **No-progress guard** — the diff hash is unchanged after a `revise-code`
   job. The implementer has stopped responding to the review.

Rounds are not free. Every one is two model calls plus a baseline run, so the
cap is a budget control, not just a safety valve.

## Worktree strategy

One worktree and one branch per run, created from a frozen commit:

```text
git worktree add <repo>/.debug-runs/<run-id>/tree <run-id> --detach <commit>
```

- The user's working tree is never touched. The existing clean-worktree
  precondition (`lib/pipeline.mjs:533`) still applies to the *source* tree, so
  the frozen commit is meaningful.
- The worktree lives under the run directory, which is already gitignored.
- Removed on success only. A failed or unconverged run leaves its tree in place
  for inspection; `orchestrate.mjs implement --clean <run-id>` removes it.
- Baseline commands run **inside the worktree**, so a broken change cannot
  affect the checkout the user is working in.

Worktrees, not clones: they share the object store, so setup is near-instant
even on a large history, and `node_modules` is the only thing needing a copy or
a link. **Open question: whether to symlink or reinstall `node_modules`.**
Symlinking is fast but lets a change to dependencies leak across trees.

## Handoff between providers

The reviewer never sees the implementer's prose, only its output — same
principle as scan's identity-stripped challenge payload.

**Implementer → reviewer** (`implement` and `revise-code` produce):

| Field | Meaning |
| --- | --- |
| `diff` | `git diff <base>` from inside the worktree, unified, truncated at a byte cap with an explicit marker |
| `files_changed` | paths, for cheap filtering |
| `summary` | what was attempted, one paragraph |
| `assumptions` | explicit list; the reviewer is told to attack these first |
| `baseline` | result of each command in `BASELINE_COMMANDS` |

**Reviewer → implementer** (`review` produces) — modelled directly on
`schemas/verdicts.schema.json`, which already carries
`rationale` / `supporting_evidence` / `invalidating_evidence`:

| Field | Meaning |
| --- | --- |
| `findings[].severity` | `blocking` \| `should-fix` \| `nit` — only `blocking` prevents acceptance |
| `findings[].file`, `line` | anchor, validated against the worktree as scan already does in `lib/normalize.mjs` |
| `findings[].claim` | what is wrong |
| `findings[].failure_scenario` | concrete inputs → wrong behaviour; a finding without one is downgraded to `nit` |
| `verdict` | `accept` \| `revise` |

The `failure_scenario` requirement is load-bearing. Without it a reviewer fills
its quota with style opinions, and the loop never converges because there is
always another opinion available.

## Safety

Carried over from the scan pipeline, and asserted in `lib/providers/safety.mjs`
before spawn as scan already does:

- **Reviewer is read-only in every phase.** Codex `--sandbox read-only`; Claude
  `--permission-mode plan` with `--tools Read,Glob,Grep`. A reviewer that can
  edit the tree it is reviewing is not a reviewer.
- **Implementer writes only inside its worktree.** `--cd <worktree>` for Codex
  with a workspace-write sandbox; `danger-full-access` and
  `--dangerously-bypass-approvals-and-sandbox` stay rejected before spawn.
- **Nothing is published.** No commit, push, branch on `origin`, issue, or PR.
  The deliverable is a diff plus a report.
- **Clean source worktree required**, so the frozen commit is real.
- Recorded argv redacts inline schemas; environments and tokens are never
  logged.

## Reuse

Almost all the machinery exists. New code should be confined to the worktree
manager and the implement/review phases.

| Reused as-is | For |
| --- | --- |
| `lib/run-store.mjs` | run directory layout, `atomicWriteJson`, run ids |
| `lib/queue.mjs` | per-provider bounded concurrency and retry |
| `lib/providers/{claude,codex}.mjs` | adapters, capability probes |
| `lib/providers/safety.mjs` | pre-spawn argv assertions |
| `lib/validate.mjs` | schema validation, `toProviderSchema` projection |
| `lib/proc.mjs` | command resolution, timeouts, tree kill |
| `lib/preflight.mjs` | version floors, baseline commands |
| `lib/report.mjs` | extended with implement-run sections |

| New | For |
| --- | --- |
| `lib/worktree.mjs` | create, verify, and remove per-run worktrees |
| `lib/implement.mjs` | phase graph, convergence, diff hashing |
| `prompts/{plan,critique,implement,review}.md` | the four role prompts |
| `schemas/{plan,review}.schema.json` | handoff shapes above |

## Resumability

Extends the existing input-hash scheme. Each job hashes the commit, provider and
model config, phase, **round number**, prompt contents, schema contents, and —
new — **the base diff it was given**. A job is skipped only when its status is
`succeeded`, its input hash matches, and its normalized output still parses.

Round *n* depends on round *n−1*'s diff, so resuming a run mid-loop replays from
the first round whose inputs changed. Editing a prompt invalidates every
dependent round, as it should.

## Run storage

```text
.debug-runs/<run-id>/
├── run.json           # commit, config, phase/round counters, status
├── jobs.jsonl         # append-only; last record per job id wins
├── tree/              # the git worktree
├── prompts/           # exact prompt per job
├── raw/<provider>/    # stdout, stderr, structured result
├── rounds/<n>/
│   ├── diff.patch     # implementer output for this round
│   ├── review.json    # reviewer findings
│   └── baseline.json  # command results
└── report.md
```

## CLI

```powershell
npm run bugs:implement -- --candidate <candidate-id> --run <scan-run-id>
npm run bugs:implement -- --task "Fix the 5h usage cooldown"
npm run bugs:implement -- --resume <run-id>
npm run bugs:implement -- --clean <run-id>     # remove the worktree
```

Flags mirror `scan`: `--provider` picks the implementer (the other provider
reviews), `--max-rounds` overrides the cap.

## Decisions taken at implementation

The five open questions, resolved. All but the last are config, not
architecture, so they are cheap to revisit.

1. **Claude implements, Codex reviews, by default.** `--provider` picks the
   implementer and the other one reviews; `assignRoles` enforces that they are
   always different. This matches the pairing the Dispatch tab already uses.
2. **Full diff every round.** Simpler and more correct than tracking deltas; the
   diff is truncated at 400 KB with an explicit marker rather than silently
   clipped, so a reviewer always knows it is seeing a partial change.
3. **Task identity is the candidate id, or a hash of the normalized task text.**
   `taskIdentity` returns `{kind, id}`, so free-form runs get a stable
   `task-<hash>` anchor without a fake candidate id.
4. **`node_modules` is junctioned, falling back to a copy.** A junction needs no
   elevation on Windows — verified against this repo — and the strategy used is
   recorded in `run.json`, so a later baseline failure is explainable rather
   than mysterious.

   **The junction must be unlinked before anything walks the worktree.** A
   junction is a real directory entry, so a recursive delete that follows it
   deletes the *target*. `git worktree remove --force` does exactly that: during
   development it emptied this repository's own `node_modules/.bin`.
   `removeWorktree` now calls `unlinkDependencies` first, and refuses to
   continue if the unlink fails rather than falling back to a recursive delete.
   `test/worktree.test.mjs` pins the behaviour and fails if that ordering is
   ever reversed.
5. **The reviewer still does not run tests.** It stays read-only; the baseline
   runs between implement and review, and its results are handed to the reviewer
   as evidence. Giving the reviewer its own sandbox is deferred — it would mean
   a second writer, which is the one thing this design is careful to avoid.

## Deviations from the design

- **No separate `revise-plan` phase.** The critique is fed directly into the
  first `implement` job, which already has to reconcile review findings. A
  dedicated phase would have been a third model call to restate the same
  information.
- **Two extra stop conditions**, both found while testing: `no-changes` (the
  implementer edited nothing) and `stalled` (byte-identical diff between
  rounds). Without them a stuck implementer burns every remaining round.
- **Reviewer verdicts are recomputed, not trusted.** `normalizeReview` derives
  `verdict` from whether any `blocking` finding survives, keeping the reviewer's
  own claim as `claimedVerdict`. A reviewer that says `revise` while raising
  only nits would otherwise block forever.
