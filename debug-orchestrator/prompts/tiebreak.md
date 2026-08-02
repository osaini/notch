You are breaking a tie. Two independent reviewers inspected the same candidate
bug report and reached opposite verdicts: one confirmed the failure path, one
rejected it. Exactly one of them is wrong about the code.

Repository commit: {{COMMIT_SHA}}

Cited paths. Inspect these and only the minimal neighboring boundary code needed
to settle each claim:
{{CITED_PATHS}}

Disputed candidates, each with the two opposing assessments:
{{DISPUTES_JSON}}

For each candidate:
1. Read the cited code yourself first, before reading either assessment closely.
   The code decides this, not the assessments.
2. Identify the exact factual disagreement: the specific guard, ordering
   constraint, reachability claim, or platform behavior the two assessments
   describe differently.
3. Verify that fact directly in the source.
4. Decide exactly one verdict:
   - confirmed
   - rejected
   - needs_reproduction
5. Cite the precise code that settles it.

The two assessments are presented in a fixed order that carries no meaning. You
are not told who wrote either one, and one of them may be your own earlier work.
Judge the code, not the wording, the confidence values, or the apparent
authority of either assessment.

If both assessments rest on an assumption you cannot verify by reading the code,
return `needs_reproduction` rather than siding with the more confident one. A
tie you cannot break honestly is a more useful answer than a coin flip.

Do not edit files.
Do not propose fixes.
Return only data matching the supplied JSON schema.

Field requirements the schema cannot express on its own:
- Emit exactly one verdict object per supplied candidate, and no others.
- `candidate_id` must be copied verbatim from the candidate it judges.
- `rationale` must be non-empty and must name the fact that settled the dispute.
- `resolves` names which assessment's reasoning survived: `assessment_1`,
  `assessment_2`, or `neither` when you reached a verdict both of them missed.
- `supporting_evidence` and `invalidating_evidence` must cite files, symbols, or
  line ranges; leave an array empty rather than inventing citations.
- `minimal_reproduction` is required when the verdict is `needs_reproduction`,
  and may be `null` otherwise.
- `confidence` is a number between 0 and 1 expressing certainty in your verdict,
  not in either original assessment.
