import { useState } from 'react'
import { supabase } from '../supabaseClient'
import { getOrCreateReactionOwnerToken } from '../lib/pseudoId'

// Heart-only reaction, matching the simplified interaction model:
// a single heart + a comment thread, no multi-emoji picker.
const HEART = '❤️'
const STORAGE_KEY = 'unsaid_my_reactions'

function getMyReactions() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function setMyReaction(postId, liked) {
  try {
    const all = getMyReactions()
    if (liked) all[postId] = HEART
    else delete all[postId]
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // best effort only
  }
}

export default function ReactionBar({ postId, pseudoId, initialCount }) {
  const [count, setCount] = useState(initialCount || 0)
  const [liked, setLiked] = useState(() => !!getMyReactions()[postId])
  const [busy, setBusy] = useState(false)

  async function handleTap() {
    if (busy) return
    setBusy(true)

    const prevCount = count
    const prevLiked = liked
    const nextLiked = !liked
    setCount((c) => (nextLiked ? c + 1 : Math.max(0, c - 1)))
    setLiked(nextLiked)
    setMyReaction(postId, nextLiked)

    // UX/SECURITY FIX (audit finding): supabase-js does NOT throw for an
    // RPC-level failure (like the owner-token mismatch raised by
    // react_to_post/remove_reaction) — it comes back as `error` in the
    // result, not a thrown exception. The try/catch below only ever
    // catches a network-level failure, so a real ownership rejection
    // (e.g. a legacy pre-section-26 reaction with no registered token)
    // used to leave the heart stuck showing the wrong state forever,
    // silently out of sync with the database. Both branches now revert
    // the optimistic change on any `error`, not just a thrown one.
    try {
      const ownerToken = getOrCreateReactionOwnerToken(postId)
      let result
      if (nextLiked) {
        result = await supabase.rpc('react_to_post', {
          p_post_id: postId,
          p_pseudo_id: pseudoId,
          p_emoji: HEART,
          p_owner_token: ownerToken,
        })
      } else {
        result = await supabase.rpc('remove_reaction', {
          p_post_id: postId,
          p_pseudo_id: pseudoId,
          p_owner_token: ownerToken,
        })
      }

      if (result.error) {
        setCount(prevCount)
        setLiked(prevLiked)
        setMyReaction(postId, prevLiked)
      } else if (result.data) {
        setCount(result.data[HEART] || 0)
      }
    } catch {
      setCount(prevCount)
      setLiked(prevLiked)
      setMyReaction(postId, prevLiked)
    }

    setBusy(false)
  }

  return (
    <button
      type="button"
      onClick={handleTap}
      disabled={busy}
      aria-pressed={liked}
      aria-label={liked ? 'Remove heart' : 'Send a heart'}
      className={`flex items-center gap-1.5 rounded-full px-2 py-1 text-xs transition ${
        liked ? 'text-rose-400' : 'text-zinc-400 hover:text-rose-300'
      }`}
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill={liked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 20.727c-.313 0-.625-.096-.879-.288C7.83 18.14 3 13.943 3 9.545 3 6.484 5.36 4 8.25 4c1.68 0 3.176.82 4.125 2.09A5.06 5.06 0 0 1 15.75 4C18.64 4 21 6.484 21 9.545c0 4.398-4.83 8.595-8.121 10.894a1.5 1.5 0 0 1-.879.288Z" />
      </svg>
      <span className="tabular-nums">{count}</span>
    </button>
  )
}
