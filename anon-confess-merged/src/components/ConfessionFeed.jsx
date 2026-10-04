import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../supabaseClient'
import ConfessionCard from './ConfessionCard'

const PAGE_SIZE = 20
const REACTIONS_KEY = 'unsaid_my_reactions'

function getLikedPostIdsLocal() {
  try {
    const raw = window.localStorage.getItem(REACTIONS_KEY)
    return raw ? new Set(Object.keys(JSON.parse(raw))) : new Set()
  } catch {
    return new Set()
  }
}

export default function ConfessionFeed({ refreshSignal, pseudoId, onlyLiked, blockedIds, onBlocked, focusPostId, onOpenProfile, isAdmin, isSignedIn, onRequestSignIn }) {
  const [posts, setPosts] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState(null)
  const [openMenuPostId, setOpenMenuPostId] = useState(null)
  const [openCommentsPostId, setOpenCommentsPostId] = useState(null)
  const [pinnedPost, setPinnedPost] = useState(null)

  const loadPosts = useCallback(async () => {
    setError(null)
    const { data, error: fetchError } = await supabase
      .from('posts')
      .select('id, created_at, content, pseudo_id, likes_count, comments_count')
      .order('created_at', { ascending: false })
      .range(0, PAGE_SIZE - 1)

    if (fetchError) {
      setError("Couldn't load confessions right now.")
    } else {
      setPosts(data ?? [])
      setHasMore((data ?? []).length === PAGE_SIZE)
    }
    setLoading(false)
  }, [])

  async function loadMore() {
    setLoadingMore(true)
    const { data, error: fetchError } = await supabase
      .from('posts')
      .select('id, created_at, content, pseudo_id, likes_count, comments_count')
      .order('created_at', { ascending: false })
      .range(posts.length, posts.length + PAGE_SIZE - 1)

    if (!fetchError) {
      setPosts((current) => [...current, ...(data ?? [])])
      setHasMore((data ?? []).length === PAGE_SIZE)
    }
    setLoadingMore(false)
  }

  useEffect(() => {
    loadPosts()
  }, [loadPosts, refreshSignal])

  // A confession opened via its direct link (?post=<id>) might not be on
  // the first page of the normal feed — fetch it once on its own and pin
  // it above everything else so the link always resolves to something.
  useEffect(() => {
    if (!focusPostId) return
    let active = true
    supabase
      .from('posts')
      .select('id, created_at, content, pseudo_id, likes_count, comments_count')
      .eq('id', focusPostId)
      .maybeSingle()
      .then(({ data }) => {
        if (active && data) setPinnedPost(data)
      })
    return () => {
      active = false
    }
  }, [focusPostId])

  useEffect(() => {
    const channel = supabase
      .channel('public:posts')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, (payload) => {
        setPosts((current) => [payload.new, ...current])
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'posts' }, (payload) => {
        setPosts((current) => current.map((p) => (p.id === payload.new.id ? payload.new : p)))
        setPinnedPost((current) => (current?.id === payload.new.id ? payload.new : current))
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts' }, (payload) => {
        setPosts((current) => current.filter((p) => p.id !== payload.old.id))
        setPinnedPost((current) => (current?.id === payload.old.id ? null : current))
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  function handleDeleted(postId) {
    setPosts((current) => current.filter((p) => p.id !== postId))
    setPinnedPost((current) => (current?.id === postId ? null : current))
  }

  const blocked = blockedIds ?? new Set()
  let visiblePosts = posts.filter((p) => !blocked.has(p.pseudo_id))
  if (onlyLiked) {
    const likedIds = getLikedPostIdsLocal()
    visiblePosts = visiblePosts.filter((p) => likedIds.has(p.id))
  }

  const showPinned = pinnedPost && !blocked.has(pinnedPost.pseudo_id) && !visiblePosts.some((p) => p.id === pinnedPost.id)

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

  if (visiblePosts.length === 0 && !showPinned) {
    return (
      <div className="rounded-2xl border border-white/5 bg-base-900/30 p-8 text-center text-sm text-zinc-500">
        {onlyLiked
          ? "You haven't hearted anything yet in this browser."
          : 'Nothing shared yet. Be the first to say it.'}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {showPinned && (
        <div>
          <p className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-hush-400">
            Shared confession
          </p>
          <ConfessionCard
            post={pinnedPost}
            pseudoId={pseudoId}
            onBlocked={onBlocked}
            onDeleted={handleDeleted}
            menuOpen={openMenuPostId === pinnedPost.id}
            onToggleMenu={setOpenMenuPostId}
            commentsOpen={openCommentsPostId === pinnedPost.id}
            onToggleComments={setOpenCommentsPostId}
            onOpenProfile={onOpenProfile}
            isAdmin={isAdmin}
            blockedIds={blocked}
            isSignedIn={isSignedIn}
            onRequestSignIn={onRequestSignIn}
          />
        </div>
      )}
      {visiblePosts.map((post) => (
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
      {!onlyLiked && hasMore && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loadingMore}
          className="w-full rounded-full border border-white/10 bg-base-900/50 px-4 py-2 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
