import fsp from 'node:fs/promises'

/**
 * Claude Code transcripts run to megabytes, and the record we want is always the
 * last few. Reading a fixed window off the end keeps this cheap enough to run on
 * every Stop hook.
 */
const TAIL_BYTES = 64 * 1024
/** A follow-up question is a sentence, not an essay. */
const MAX_QUESTION_CHARS = 400

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Concatenated text of the last assistant turn in a transcript.
 *
 * Records are JSONL: `{ type: 'assistant', message: { content: [{type, text}] } }`,
 * interleaved with system, attachment and snapshot entries that are skipped.
 * Returns '' when the tail holds no assistant text — including when the window
 * sliced a record in half, since that line simply fails to parse.
 */
export function lastAssistantText(tail: string): string {
  const lines = tail.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (!line || line.charCodeAt(0) !== 123) continue
    let parsed: Record<string, unknown> | null
    try {
      parsed = record(JSON.parse(line))
    } catch {
      continue
    }
    if (parsed?.type !== 'assistant') continue
    const message = record(parsed.message)
    const content = message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .flatMap((block) => {
        const entry = record(block)
        return entry?.type === 'text' && typeof entry.text === 'string' ? [entry.text] : []
      })
      .join('\n')
      .trim()
    if (text) return text
  }
  return ''
}

/**
 * The trailing question of an assistant turn, if it ends by asking something.
 *
 * Only the closing sentence is offered: the turn is usually a long report and
 * the question is the part the user still has to act on. Prose that merely
 * contains a question mark earlier on is not a prompt for input, so anything
 * not ending in `?` yields ''.
 */
export function trailingQuestion(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.endsWith('?')) return ''
  // Walk back to the start of the closing sentence. Bullets and headings count
  // as boundaries so a question in a list does not drag the whole list along.
  const boundary = Math.max(
    trimmed.lastIndexOf('. ', trimmed.length - 2),
    trimmed.lastIndexOf('\n', trimmed.length - 2),
    trimmed.lastIndexOf('! ', trimmed.length - 2),
    trimmed.lastIndexOf('? ', trimmed.length - 2)
  )
  const sentence = (boundary === -1 ? trimmed : trimmed.slice(boundary + 1)).trim()
  const question = sentence.replace(/^[-*>#\s]+/, '').trim()
  // No need to re-check for the '?': `sentence` is a suffix of `trimmed`, which
  // the guard above already proved ends in one, and the strip only takes from
  // the front. Only an all-punctuation line can come back empty.
  if (!question) return ''
  return question.length > MAX_QUESTION_CHARS
    ? `…${question.slice(-(MAX_QUESTION_CHARS - 1))}`
    : question
}

/** Reads the tail of a transcript and returns its closing question, if any. */
export async function readTrailingQuestion(transcriptPath: string): Promise<string> {
  if (!transcriptPath) return ''
  let handle: Awaited<ReturnType<typeof fsp.open>>
  try {
    handle = await fsp.open(transcriptPath, 'r')
  } catch {
    return ''
  }
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, Math.max(0, size - length))
    return trailingQuestion(lastAssistantText(buffer.toString('utf8')))
  } catch {
    return ''
  } finally {
    await handle.close()
  }
}
