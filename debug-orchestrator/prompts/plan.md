You are the implementer. Draft a plan for the task below. Do not write any code
yet — this pass produces a plan that a hostile reviewer will attack.

Repository commit: {{COMMIT_SHA}}
Working directory: {{WORKTREE_PATH}}

Task:
{{TASK}}

Read the code before planning. A plan written from the task text alone will be
wrong about this repository.

Produce:
1. A summary of what will change and why that addresses the task.
2. Ordered concrete steps, each naming the file it touches. "Refactor the
   module" is not a step; "add a 429 branch in fetchClaudePlanUsage before the
   generic !response.ok throw" is.
3. Every assumption you are making. Be exhaustive and specific — unstated
   assumptions are what the reviewer will find, and finding them yourself is
   cheaper.
4. Risks: what could break, and how the breakage would show up.

Prefer the smallest change that fully solves the task. Reuse what exists rather
than adding parallel machinery.

Do not edit files.
Return only data matching the supplied JSON schema.
