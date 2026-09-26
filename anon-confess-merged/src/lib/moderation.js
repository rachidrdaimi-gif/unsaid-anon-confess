/**
 * Lightweight client-side moderation.
 *
 * IMPORTANT: this is a first-pass UX filter only, catching obvious cases
 * before a request is even sent. It is NOT a security boundary — a client
 * can always bypass client-side JS and call the Supabase REST API directly.
 * Real enforcement happens server-side too (see enforce_content_floor() in
 * supabase/schema.sql, which mirrors this list and is what actually blocks
 * an insert no matter how it's sent) — but even together, this is still a
 * short, severe-only regex list. It is NOT a replacement for a real
 * moderation pipeline (OpenAI's moderation endpoint, Perspective API,
 * etc.) called from an Edge Function before content goes fully public —
 * regex lists are always evadable with creative spelling, and this one,
 * however broadened, is no exception.
 *
 * Philosophy: this is a support/confession space, so the filter is
 * deliberately narrow. It blocks slurs, explicit hate speech, severe
 * harassment, threats, and doxxing — but it does NOT block words like
 * "die", "hate", "hurt", "suicide", "worthless", etc., because people
 * need to be able to describe real pain without being censored. If you
 * need crisis-detection (e.g. to surface a helpline banner) that is a
 * SEPARATE, additive feature — see needsSupportBanner below — never a
 * reason to block a post.
 */

// Kept severe-only and organized by category so it's easy to audit and
// extend. Each entry still allows the same handful of common evasions
// (leetspeak digit/symbol swaps, optional plural/suffix) the original
// short list already handled for the n-word/faggot/kike/spic/chink/
// tranny entries — broadened to cover more terms the same way, not a
// different strategy. This keeps the client (here) and server
// (enforce_content_floor in schema.sql) easy to keep in sync by eye.
const BLOCKED_PATTERNS = [
  // --- Slurs / hate speech, by targeted group -------------------------
  // Race / ethnicity
  /\bn[i1!]gg(?:er|a)\b/i,
  /\bsp[i1!]c\b/i,
  /\bch[i1!]nk\b/i,
  /\bg[o0]{2}k\b/i,
  /\bwetback\b/i,
  /\bp[a4]ki\b/i,
  /\bred\s?skin(s)?\b/i,
  // Religion
  /\bk[i1!]ke\b/i,
  /\bt[o0]wel\s?head\b/i,
  // Sexual orientation / gender identity
  /\bf[a4]gg?ot\b/i,
  /\btr[a4]nn(y|ies)\b/i,
  /\bd[y1!]ke\b/i,
  // Disability
  /\bretard(ed)?\b/i,

  // --- Explicit sexual content -----------------------------------------
  /\bporn(hub|ography)?\b/i,
  /\brape\s?(me|you|her|him|them)\b/i,

  // --- Direct threats / calls for violence against a person -----------
  /\bi\s?(will|'ll|am going to)\s?(kill|murder|hurt|stab|shoot|beat up|assault)\s?(you|him|her|them)\b/i,
  /\bkill\s?yourself\b/i,
  /\bkys\b/i,
  /\bi\s?know\s?where\s?you\s?live\b/i,
  /\bi('m|\s?am)\s?(going to|gonna)\s?find\s?you\b/i,

  // --- Targeted misogynistic harassment ("you're a ___") --------------
  // Scoped to a direct accusation aimed at someone, not a bare word, so
  // it doesn't catch people describing what happened to them.
  /\byou('re| are)\s?(a\s)?(wh[o0]re|slut)\b/i,

  // --- Doxxing — posting a third party's identifying details ----------
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, // phone number
  /\b\d{1,5}\s\w+(\s\w+){0,3}\s(street|st|avenue|ave|road|rd|drive|dr|lane|ln|blvd)\b/i, // street address
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN-shaped number

  // --- Spam / scam -------------------------------------------------------
  /\b(dm|message) me (for|to get) (content|nudes|crypto|investment)\b/i,
  /\bguaranteed\s?(returns|profit)\b/i,
  /\bonlyfans\.com\/\S+/i,
]

const SUPPORT_TRIGGERS = [
  /\bsuicid(e|al)\b/i,
  /\bkill myself\b/i,
  /\bend it all\b/i,
  /\bwant to die\b/i,
  /\bself[-\s]?harm\b/i,
]

export function moderateContent(text) {
  const trimmed = text.trim()

  if (!trimmed) {
    return { allowed: false, reason: 'Write something before sharing.' }
  }
  if (trimmed.length > 500) {
    return { allowed: false, reason: 'Keep it under 500 characters.' }
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        reason:
          'This space is for support, not harassment or hate. Please rephrase.',
      }
    }
  }

  return { allowed: true }
}

/** Non-blocking: flags posts that might warrant a gentle crisis-resource nudge. */
export function needsSupportBanner(text) {
  return SUPPORT_TRIGGERS.some((pattern) => pattern.test(text))
}
