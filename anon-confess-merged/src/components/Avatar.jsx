import { useEffect, useState } from 'react'
import { getCachedAvatar, fetchAvatar, subscribeAvatar } from '../lib/avatarCache'

function initialsFromPseudoId(pseudoId) {
  const digits = pseudoId.replace('#AnonUser', '')
  return digits.slice(0, 2)
}

/** A small circular avatar for a pseudo_id — the uploaded picture if one
 * exists, otherwise the first couple digits of the anonymous id as a
 * placeholder. Clicking it opens that pseudo_id's public profile, same as
 * clicking their name (see ConfessionCard.jsx / CommentThread.jsx). */
export default function Avatar({ pseudoId, size = 32, onClick, className = '' }) {
  const [url, setUrl] = useState(() => getCachedAvatar(pseudoId) ?? null)

  useEffect(() => {
    const cached = getCachedAvatar(pseudoId)
    setUrl(cached ?? null)
    if (cached === undefined) fetchAvatar(pseudoId)
    return subscribeAvatar(pseudoId, setUrl)
  }, [pseudoId])

  const dim = `${size}px`

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`View ${pseudoId}'s profile`}
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-base-800 text-zinc-500 ${className}`}
      style={{ width: dim, height: dim, fontSize: `${Math.max(9, size * 0.38)}px` }}
    >
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="font-medium tabular-nums">{initialsFromPseudoId(pseudoId)}</span>
      )}
    </button>
  )
}
