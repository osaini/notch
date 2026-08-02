You are sequencing a batch of bug fixes. Do not write any code in this pass —
this produces an order of work, not a solution to any single bug.

Repository commit: {{COMMIT_SHA}}
Working directory: {{WORKTREE_PATH}}

Findings to fix, each already confirmed independently by two reviewers:
{{FINDINGS_JSON}}

Every one of these will be fixed in turn, in the same working tree, one at a
time. Later fixes see the earlier ones already applied. Your job is to choose
the order that makes that safe.

Read the cited code before sequencing. Ordering chosen from the titles alone
will be wrong about which of these actually touch each other.

Produce, for every supplied finding:
1. Its position in the order, starting at 1. Every finding gets exactly one
   position and no two share a position.
2. Why it sits there — specifically, what makes it safe to do at that point.
3. Which other findings it interacts with: shared file, shared function, shared
   state, or a fix that would change the code the other one is about.

Ordering principles, strongest first:
- A fix that changes a shared helper or type goes before fixes that depend on
  that code, so the dependents are written against the corrected version.
- Fixes to the same file should be adjacent, so a later one is not written
  against a version of the file that is about to change again.
- An isolated fix that touches nothing else can go anywhere; put those last.
- If two fixes genuinely contradict each other — one wants code the other
  deletes — say so in `conflicts`. Do not invent an order that hides it.

Be honest about interactions you are unsure of. An overstated interaction costs
an unnecessary ordering constraint; a missed one costs a broken fix.

Do not edit files.
Do not solve any of the bugs.
Return only data matching the supplied JSON schema.
