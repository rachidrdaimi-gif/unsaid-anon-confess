// Client-side, per-device block list. Blocking hides a pseudo_id's posts
// from YOUR feed only — it's not a global ban (that's what the admin
// ban_pseudo_id action is for) and doesn't require an account.
const BLOCKED_KEY = 'unsaid_blocked_ids'

export function getBlockedIds() {
  try {
    const raw = window.localStorage.getItem(BLOCKED_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

export function blockPseudoId(pseudoId) {
  try {
    const blocked = getBlockedIds()
    blocked.add(pseudoId)
    window.localStorage.setItem(BLOCKED_KEY, JSON.stringify([...blocked]))
    return blocked
  } catch {
    return getBlockedIds()
  }
}

export function unblockPseudoId(pseudoId) {
  try {
    const blocked = getBlockedIds()
    blocked.delete(pseudoId)
    window.localStorage.setItem(BLOCKED_KEY, JSON.stringify([...blocked]))
    return blocked
  } catch {
    return getBlockedIds()
  }
}
