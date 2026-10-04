import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import ConfessionCard from './ConfessionCard'

const WINDOW_DAYS = 30
const MAX_SHOWN = 30

// "Hot" ranking: engagement (a comment counts double a heart, since it takes
// more effort) divided by an age penalty, so a fresh post with a few hearts
// can outrank an old post with more — the feed keeps moving instead of
// freezing on all-time favourites.
function trendScore(post) {
  const engagement = (post.likes_count || 0) + 2 * (post.comments_count || 0)
  const hours = Math.max(0, (Date.now() - new Date(post.created_at).getTime()) / 3600000)
  return engagement / Math.pow(hours + 2, 1.3)
}

export default function TrendingFeed({
  refreshSignal,
  pseudoId,
  blockedIds,
  onBlocked,
  onOpenProfile,
  isAdmin,
  isSignedIn,
  onRequestSignIn,
}) {
  const [posts, setPosts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [openMenuPostId, setOpenMenuPostId] = useState(null)
  const [openCommentsPostId, setOpenCommentsPostId] = useState(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString()

    supabase
      .from('posts')
      .select('id, created_at, content, pseudo_id, likes_count, comments_count')
      .gte('created_at', since)
      .or('likes_count.gt.0,comments_count.gt.0')
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data, error: fetchError }) => {
        if (!active) return
        if (fetchError) {
          setError("Couldn't load trending confessions right now.")
        } else {
          const ranked = (data ?? [])
            .map((p) => ({ post: p, score: trendScore(p) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_SHOWN)
            .map((x) => x.post)
          setPosts(ranked)
        }
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [refreshSignal])

  function handleDeleted(postId) {
    setPosts((current) => current.filter((p) => p.id !== postId))
  }

  const blocked = blockedIds ?? new Set()
  const visible = posts.filter((p) => !blocked.has(p.pseudo_id))

  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl border border-white/5 bg-base-900/40" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-4 text-sm text-rose-300">
        {error}
      </div>
    )
  }

  if (visible.length === 0) {
    return (
      <div className="rounded-2xl border border-white/5 bg-base-900/30 p-8 text-center text-sm text-zinc-500">
        Nothing is trending yet. Hearts and comments on recent confessions will lift them here.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {visible.map((post) => (
        <ConfessionCard
          key={post.id}
          post={post}
          pseudoId={pseudoId}
          onBlocked={onBlocked}
          onDeleted={handleDeleted}
          menuOpen={openMenuPostId === post.id}
          onToggleMenu={setOpenMenuPostId}
          commentsOpen={openCommentsPostId === post.id}
          onToggleComments={setOpenCommentsPostId}
          onOpenProfile={onOpenProfile}
          isAdmin={isAdmin}
          blockedIds={blocked}
          isSignedIn={isSignedIn}
          onRequestSignIn={onRequestSignIn}
        />
      ))}
    </div>
  )
}
