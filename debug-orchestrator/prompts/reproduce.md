Create the smallest deterministic failing test for the supplied candidate.

Repository commit: {{COMMIT_SHA}}
Candidate:
{{CANDIDATE_JSON}}

You may edit test files and test-only fixtures in this isolated worktree.
Do not modify production code.
Do not fix the bug.
Do not weaken existing assertions.

Run the narrowest relevant command and report whether the failure matches the
candidate's predicted failure path.

If reproduction is impossible, explain the exact missing prerequisite or
incorrect assumption. Return only data matching the supplied JSON schema.

Field requirements the schema cannot express on its own:
- `candidate_id` must be copied verbatim from the candidate.
- `command` is the exact command you ran, or `null` if you ran none.
- `exit_code` is that command's exit status, or `null` if you ran none.
- `observed_output` is the relevant excerpt of stdout/stderr, not the full log.
- `test_files_changed` lists repository-relative paths using `/` separators.
- `matches_predicted_failure_path` is `false` whenever the test fails for a
  different reason than the candidate predicted.
