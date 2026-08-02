import { PipelineError } from './cli.mjs';

/**
 * The two dispatch tracks.
 *
 * Each track is one complete find-then-verify line of reasoning, kept separate
 * from the other all the way through the challenge phase. Track A is Claude
 * finding and Codex verifying; Track B is the mirror image.
 *
 * Keeping them apart is the whole point. A single merged pool challenges a
 * jointly discovered bug exactly once, so you never learn whether *both*
 * verifiers would have stood behind it — and there is nothing left to compare.
 */
export const TRACKS = [
  { id: 'A', finder: 'claude', challenger: 'codex' },
  { id: 'B', finder: 'codex', challenger: 'claude' }
];

export const TRACK_IDS = TRACKS.map((track) => track.id);

export function trackById(id) {
  const track = TRACKS.find((entry) => entry.id === id);
  if (!track) throw new PipelineError(`Unknown track "${id}". Expected one of: ${TRACK_IDS.join(', ')}.`);
  return track;
}

export function trackForFinder(provider) {
  return TRACKS.find((track) => track.finder === provider) ?? null;
}

/**
 * The tracks a run can actually execute.
 *
 * A provider-restricted run (`--provider claude`) has only one finder, so it has
 * only one track and no opposing verifier. It is a smoke test, not a discovery
 * run, and the caller skips the challenge phase for it.
 */
export function tracksFor(providers) {
  return TRACKS.filter((track) => providers.includes(track.finder) && providers.includes(track.challenger));
}

/**
 * Verdicts are keyed by track *and* candidate.
 *
 * A candidate both tracks found carries two independent verdicts under the same
 * candidate id. Keying on the id alone silently keeps whichever landed last and
 * throws away half the verification work.
 */
export function verdictKey(track, candidateId) {
  return `${track}:${candidateId}`;
}
