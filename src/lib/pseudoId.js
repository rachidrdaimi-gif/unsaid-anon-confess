const STORAGE_KEY = 'unsaid_pseudo_id'
const LIKED_KEY = 'unsaid_liked_posts'
const OWNER_TOKENS_KEY = 'unsaid_owner_tokens'

/**
 * Returns this browser's pseudo-anonymous handle, e.g. "#AnonUser9482".
 * Generated once and persisted in localStorage — never derived from any
 * personally identifying data (no IP, no fingerprinting, no accounts).
 */
export function getPseudoId() {
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY)
    if (existing) return existing

    const id = generatePseudoId()
    window.localStorage.setItem(STORAGE_KEY, id)
    return id
  } catch {
    // localStorage unavailable (private mode / disabled) — fall back to an
    // in-memory id for this session only.
    return generatePseudoId()
  }
}

function generatePseudoId() {
  // 6 digits (100000-999999) instead of 4 (1000-9999): the old range only
  // had ~9,000 possible ids, so two unrelated visitors — or worse, an
  // attacker deliberately signing up under an id they saw on someone
  // else's post — would collide easily. Matches the max already allowed
  // by the server-side pseudo_id_format check.
  const number = Math.floor(100000 + Math.random() * 900000)
  return `#AnonUser${number}`
}

/** Tracks which post ids this browser has already hearted, client-side. */
export function getLikedPostIds() {
  try {
    const raw = window.localStorage.getItem(LIKED_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

export function markPostLiked(postId) {
  try {
    const liked = getLikedPostIds()
    liked.add(postId)
    window.localStorage.setItem(LIKED_KEY, JSON.stringify([...liked]))
  } catch {
    // best effort only — server-side unique constraint is the real guard
  }
}

// SECURITY FIX (audit finding): an anonymous (not signed-in) post's
// pseudo_id and post id are both PUBLIC — anyone can read them straight
// off the feed. Without a real secret, "delete my own post" for an
// anonymous poster could not be told apart from "delete anyone's post" —
// any visitor could call the delete function with a pseudo_id and post id
// copied off someone else's post. This owner token is a random secret
// generated only on the poster's own device, sent once at creation time,
// and never readable back from the database by anyone (see
// post_owner_tokens in the schema) — so it can't be discovered the way
// pseudo_id and post id can.
function getOwnerTokens() {
  try {
    const raw = window.localStorage.getItem(OWNER_TOKENS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function saveOwnerToken(postId, ownerToken) {
  try {
    const tokens = getOwnerTokens()
    tokens[postId] = ownerToken
    window.localStorage.setItem(OWNER_TOKENS_KEY, JSON.stringify(tokens))
  } catch {
    // If this fails, the post simply can't be self-deleted later — it can
    // still be removed by an admin.
  }
}

export function getOwnerToken(postId) {
  return getOwnerTokens()[postId] || null
}

// SECURITY FIX (audit finding): "Claim your id" (signUpWithPseudoId) let
// anyone type in ANY pseudo_id — including one that already has posts or
// comments from someone else, since it's fully public and freely
// editable in AuthModal's input — and register a password for it. Since
// handle_new_user() only rejected a requested id that was already
// CLAIMED (a profiles row already exists for it), a never-claimed but
// already-active identity could be squatted by a stranger: the real
// anonymous author would then permanently lose the ability to ever
// claim their own posting handle ("email already registered"), and the
// squatter could keep posting new content under that identity's public
// reputation going forward (existing posts/comments stay protected by
// their own owner tokens either way, so nothing already posted can be
// altered or deleted by the squatter).
//
// The fix (see schema.sql section 27): claiming an id that already has
// public content now requires proof the claiming browser actually
// authored something under it — any one of this browser's own stored
// post/comment owner tokens is sufficient, since only the real author's
// browser ever received one. A brand-new, never-posted-under id needs
// no proof (there's nothing to squat).
export function getAnyOwnershipProof() {
  const posts = getOwnerTokens()
  const firstPostId = Object.keys(posts)[0]
  if (firstPostId) {
    return { postId: firstPostId, postOwnerToken: posts[firstPostId] }
  }
  const comments = readTokenMap(COMMENT_OWNER_TOKENS_KEY)
  const firstCommentId = Object.keys(comments)[0]
  if (firstCommentId) {
    return { commentId: firstCommentId, commentOwnerToken: comments[firstCommentId] }
  }
  return null
}

// SECURITY FIX (audit finding, section 26): comments and reactions had the
// exact same gap posts used to have — an anonymous pseudo_id is public, so
// it couldn't prove who actually posted a comment or sent a heart. These
// follow the same pattern as the post owner token above: a random secret
// generated only on the acting device, sent once, and never readable back
// from the database.
const COMMENT_OWNER_TOKENS_KEY = 'unsaid_comment_owner_tokens'
const REACTION_OWNER_TOKENS_KEY = 'unsaid_reaction_owner_tokens'

function readTokenMap(key) {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function writeTokenMap(key, tokens) {
  try {
    window.localStorage.setItem(key, JSON.stringify(tokens))
  } catch {
    // If this fails, the comment/reaction simply can't be self-managed
    // later — it can still be removed by an admin.
  }
}

export function saveCommentOwnerToken(commentId, ownerToken) {
  const tokens = readTokenMap(COMMENT_OWNER_TOKENS_KEY)
  tokens[commentId] = ownerToken
  writeTokenMap(COMMENT_OWNER_TOKENS_KEY, tokens)
}

export function getCommentOwnerToken(commentId) {
  return readTokenMap(COMMENT_OWNER_TOKENS_KEY)[commentId] || null
}

// One reaction owner token per post (the reactions table is keyed by
// post_id + pseudo_id, so a single secret per post is enough to prove
// "this browser owns this pseudo_id's heart on this post" for both
// react_to_post and remove_reaction). Generated lazily on first use and
// reused for every later toggle from the same browser.
export function getOrCreateReactionOwnerToken(postId) {
  const tokens = readTokenMap(REACTION_OWNER_TOKENS_KEY)
  if (tokens[postId]) return tokens[postId]
  const token = crypto.randomUUID()
  tokens[postId] = token
  writeTokenMap(REACTION_OWNER_TOKENS_KEY, tokens)
  return token
}
