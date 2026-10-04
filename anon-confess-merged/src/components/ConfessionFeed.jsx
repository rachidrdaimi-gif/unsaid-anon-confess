import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '../supabaseClient'
import ConfessionCard from './ConfessionCard'

const PAGE_SIZE = 20
// The home feed pulls in this many of the most recent confessions and
// shows them in a random order (not newest-first). Time ordering still
// applies on a person's profile page.
const POOL_SIZE = 300
const REACTIONS_KEY = 'unsaid_my_reactions'
const POST_COLUMNS = 'id, created_at, content, pseudo_id, likes_count, comments_count'

function getLikedPostIdsLocal() {
  try {
    const raw = window.localStorage.getItem(REACTIONS_KEY)
    return raw ? new Set(Object.keys(JSON.parse(raw))) : new Set()
  } catch {
    return new Set()
  }
}

// Every entry gets a unique key (_k) and a round number (_r) so the same
// confession can come back again in a later round without React key clashes.
function tag(list, round) {
  return list.map((p) => ({ ...p, _k: `${p.id}:${round}`, _r: round }))
}

// Endless feed: when every confession has been shown, a freshly shuffled
// round of the same pool is appended (tiny pools do not loop).
const MIN_POOL_TO_LOOP = 5

function shuffle(list) {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export default function ConfessionFeed({ refreshSignal, pseudoId, onlyLiked, blockedIds, onBlocked, focusPostId, onOpenProfile, isAdmin, isSignedIn, onRequestSignIn }) {
  // items = the shuffled pool, shown = how many of them are revealed so far.
  const [feed, setFeed] = useState({ items: [], shown: PAGE_SIZE, round: 0 })
  const sentinelRef = useRef(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [openMenuPostId, setOpenMenuPostId] = useState(null)
  const [openCommentsPostId, setOpenCommentsPostId] = useState(null)
  const [pinnedPost, setPinnedPost] = useState(null)

  const pseudoIdRef = useRef(pseudoId)
  pseudoIdRef.current = pseudoId

  // The author's own new post goes to the very top — for them only.
  function addOwnPost(post) {
    setFeed((cur) => {
      if (cur.items.some((p) => p.id === post.id)) return cur
      return { ...cur, items: [{ ...post, _k: `${post.id}:0`, _r: 0 }, ...cur.items], shown: cur.shown + 1 }
    })
  }

  // Someone else's new post never lands at the top: it is slipped in at a
  // random spot among the confessions that are not revealed yet, so it
  // only shows up after a refresh or while scrolling down.
  function addOtherPost(post) {
    setFeed((cur) => {
      if (cur.items.some((p) => p.id === post.id)) return cur
      const min = Math.min(cur.shown, cur.items.length)
      const at = min + Math.floor(Math.random() * (cur.items.length - min + 1))
      const items = [...cur.items]
      items.splice(at, 0, { ...post, _k: `${post.id}:0`, _r: 0 })
      return { ...cur, items }
    })
  }

  const loadPosts = useCallback(async () => {
    setError(null)
    const { data, error: fetchError } = await supabase
      .from('posts')
      .select(POST_COLUMNS)
      .order('created_at', { ascending: false })
      .range(0, POOL_SIZE - 1)

    if (fetchError) {
      setError("Couldn't load confessions right now.")
    } else {
      setFeed({ items: tag(shuffle(data ?? []), 0), shown: PAGE_SIZE, round: 0 })
    }
    setLoading(false)
  }, [])

  const loadMore = useCallback(() => {
    setFeed((cur) => {
      let { items, round } = cur
      const shown = cur.shown + PAGE_SIZE
      if (shown > items.length) {
        const base = items.filter((p) => p._r === 0)
        if (base.length >= MIN_POOL_TO_LOOP) {
          round += 1
          let next = shuffle(base)
          // avoid showing the same post twice in a row at the seam
          if (next[0].id === items[items.length - 1].id) next.push(next.shift())
          items = [...items, ...tag(next, round)]
        }
      }
      return { items, round, shown: Math.min(shown, items.length) }
    })
  }, [])

  // Infinite scroll: load more as soon as the bottom marker nears the screen.
  useEffect(() => {
    if (onlyLiked) return
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore()
      },
      { rootMargin: '600px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [loadMore, onlyLiked, feed.shown, feed.items.length, loading])

  useEffect(() => {
    loadPosts()
  }, [loadPosts])

  // After this browser posts, put that post at the top of its own feed.
  useEffect(() => {
    if (!refreshSignal || !pseudoIdRef.current) return
    let active = true
    supabase
      .from('posts')
      .select(POST_COLUMNS)
      .eq('pseudo_id', pseudoIdRef.current)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (active && data) addOwnPost(data)
      })
    return () => {
      active = false
    }
  }, [refreshSignal])

  // A confession opened via its direct link (?post=<id>) might not be in
  // the pool — fetch it once on its own and pin it above everything else
  // so the link always resolves to something.
  useEffect(() => {
    if (!focusPostId) return
    let active = true
    supabase
      .from('posts')
      .select(POST_COLUMNS)
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
        if (payload.new.pseudo_id === pseudoIdRef.current) addOwnPost(payload.new)
        else addOtherPost(payload.new)
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'posts' }, (payload) => {
        setFeed((cur) => ({
          ...cur,
          items: cur.items.map((p) => (p.id === payload.new.id ? { ...payload.new, _k: p._k, _r: p._r } : p)),
        }))
        setPinnedPost((current) => (current?.id === payload.new.id ? payload.new : current))
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'posts' }, (payload) => {
        setFeed((cur) => ({ ...cur, items: cur.items.filter((p) => p.id !== payload.old.id) }))
        setPinnedPost((current) => (current?.id === payload.old.id ? null : current))
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  function handleDeleted(postId) {
    setFeed((cur) => ({ ...cur, items: cur.items.filter((p) => p.id !== postId) }))
    setPinnedPost((current) => (current?.id === postId ? null : current))
  }

  const blocked = blockedIds ?? new Set()
  let visiblePosts
  if (onlyLiked) {
    const likedIds = getLikedPostIdsLocal()
    visiblePosts = feed.items.filter((p) => p._r === 0 && !blocked.has(p.pseudo_id) && likedIds.has(p.id))
  } else {
    visiblePosts = feed.items.slice(0, feed.shown).filter((p) => !blocked.has(p.pseudo_id))
  }
  const hasMore = !onlyLiked && feed.items.length >= MIN_POOL_TO_LOOP

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
          key={post._k}
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
      {hasMore && (
        <div ref={sentinelRef} className="py-6 text-center text-xs text-zinc-600">
          …
        </div>
      )}
    </div>
  )
}
