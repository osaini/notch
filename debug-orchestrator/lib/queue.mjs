const DEFAULT_RETRY = {
  maxAttempts: 2,
  retryableStatuses: ['failed'],
  minDelayMs: 750,
  maxDelayMs: 3000
};

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded, per-provider job queue.
 *
 * - Each provider gets its own concurrency counter, so Claude and Codex never
 *   contend for the same slots.
 * - Jobs start in the order they appear in `jobs`, which keeps logs reproducible.
 * - A provider whose jobs all fail cannot cancel or starve the other provider:
 *   every lane drains independently and `execute` rejections are captured as
 *   failed results rather than propagated.
 * - A retryable failure is retried up to `retry.maxAttempts` total attempts,
 *   after a short randomized delay. Timeouts are not retried by default; `resume`
 *   is the intended recovery path for those.
 */
export async function runQueue({
  jobs,
  concurrency,
  execute,
  retry = {},
  sleep = defaultSleep,
  random = Math.random,
  onEvent = () => {}
}) {
  const policy = { ...DEFAULT_RETRY, ...retry };
  const results = new Array(jobs.length);
  const lanes = new Map();

  jobs.forEach((job, index) => {
    if (!lanes.has(job.provider)) lanes.set(job.provider, []);
    lanes.get(job.provider).push({ job, index });
  });

  const runLane = async (provider, entries) => {
    const limit = Math.max(1, Number(concurrency?.[provider] ?? 1));
    let cursor = 0;

    const worker = async () => {
      for (;;) {
        if (cursor >= entries.length) return;
        const entry = entries[cursor];
        cursor += 1;

        let attempt = 0;
        let result;
        for (;;) {
          attempt += 1;
          onEvent({ type: 'start', job: entry.job, attempt });
          try {
            result = await execute(entry.job, attempt);
          } catch (error) {
            result = { status: 'failed', errorSummary: String(error?.message ?? error) };
          }
          onEvent({ type: 'finish', job: entry.job, attempt, result });

          const retryable =
            policy.retryableStatuses.includes(result?.status) && attempt < policy.maxAttempts && result?.retryable !== false;
          if (!retryable) break;

          const span = Math.max(0, policy.maxDelayMs - policy.minDelayMs);
          await sleep(policy.minDelayMs + Math.floor(random() * span));
        }

        results[entry.index] = { job: entry.job, result, attempts: attempt };
      }
    };

    await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, () => worker()));
  };

  // Lanes are settled, not raced: one lane throwing must not abandon the others.
  const laneOutcomes = await Promise.allSettled(
    Array.from(lanes.entries(), ([provider, entries]) => runLane(provider, entries))
  );

  const laneErrors = laneOutcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) => String(outcome.reason));

  return {
    results: results.filter(Boolean),
    laneErrors
  };
}
