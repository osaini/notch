import type { UsageSnapshot } from '@shared/types'

/** Placeholder until the first scan lands, so the Usage tab never renders undefined. */
export const emptyUsage: UsageSnapshot = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  messages: 0,
  sessions: 0,
  activeDays: 0,
  currentStreak: 0,
  longestStreak: 0,
  peakHour: null,
  favoriteModel: null,
  modelBreakdown: [],
  days: [],
  block: { tokens: 0, messages: 0, startedAt: null, resetsAt: null },
  filesTracked: 0,
  scannedAt: 0,
  scanning: true,
  agentBreakdown: [
    { agent: 'claude', totalTokens: 0, messages: 0, sessions: 0 },
    { agent: 'codex', totalTokens: 0, messages: 0, sessions: 0 }
  ],
  planUsage: []
}
