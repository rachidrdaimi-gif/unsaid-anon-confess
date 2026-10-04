/**
 * Client-side throttling — a UX speed bump only. The enforceable version
 * lives server-side (see supabase/schema.sql's enforce_post_rate_limit
 * trigger), which holds even if this file is bypassed entirely.
 */
const POST_LOG_KEY = 'unsaid_post_log'
const MIN_SECONDS_BETWEEN_POSTS = 15
const MAX_POSTS_PER_DAY = 5

function readLog() {
  try {
    const raw = window.localStorage.getItem(POST_LOG_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function writeLog(timestamps) {
  try {
    window.localStorage.setItem(POST_LOG_KEY, JSON.stringify(timestamps))
  } catch {
    // ignore
  }
}

export function checkPostRateLimit() {
  const now = Date.now()
  const oneDayAgo = now - 24 * 60 * 60 * 1000
  const recent = readLog().filter((t) => t > oneDayAgo)

  if (recent.length > 0) {
    const secondsSinceLast = (now - recent[recent.length - 1]) / 1000
    if (secondsSinceLast < MIN_SECONDS_BETWEEN_POSTS) {
      return {
        allowed: false,
        waitSeconds: Math.ceil(MIN_SECONDS_BETWEEN_POSTS - secondsSinceLast),
        reason: 'Give it a moment between posts.',
      }
    }
  }

  if (recent.length >= MAX_POSTS_PER_DAY) {
    return {
      allowed: false,
      reason: `You've shared ${MAX_POSTS_PER_DAY} confessions today. Come back tomorrow.`,
    }
  }

  return { allowed: true }
}

export function recordPost() {
  const now = Date.now()
  const oneDayAgo = now - 24 * 60 * 60 * 1000
  const recent = readLog().filter((t) => t > oneDayAgo)
  recent.push(now)
  writeLog(recent)
}
