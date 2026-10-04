import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { detectDirection } from '../lib/language'

function timeAgo(isoString) {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// Real push notifications (a phone/browser alert while the app is closed)
// need infrastructure this project doesn't have yet — a service worker,
// VAPID keys, a subscriptions table, and an Edge Function to send them.
// This is the honest, self-contained version: an in-app feed of activity
// on YOUR OWN confessions, built from tables that already exist, and
// visible whenever this tab is open.
export default function NotificationsPanel({ pseudoId, refreshSignal }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!pseudoId) return
    let active = true
    setLoading(true)
    setError(null)

    async function load() {
      const { data: ownPosts, error: postsError } = await supabase
        .from('posts')
        .select('id, content')
        .eq('pseudo_id', pseudoId)

      if (postsError) {
        if (active) {
          setError("Couldn't load notifications right now.")
          setLoading(false)
        }
        return
      }

      const ownIds = (ownPosts ?? []).map((p) => p.id)
      const contentById = Object.fromEntries((ownPosts ?? []).map((p) => [p.id, p.content]))

      if (ownIds.length === 0) {
        if (active) {
          setItems([])
          setLoading(false)
        }
        return
      }

      const [{ data: comments }, { data: reactions }] = await Promise.all([
        supabase
          .from('comments')
          .select('id, post_id, pseudo_id, content, created_at')
          .in('post_id', ownIds)
          .neq('pseudo_id', pseudoId)
          .order('created_at', { ascending: false })
          .limit(30),
        supabase
          .from('reactions')
          .select('post_id, pseudo_id, emoji, created_at')
          .in('post_id', ownIds)
          .neq('pseudo_id', pseudoId)
          .order('created_at', { ascending: false })
          .limit(30),
      ])

      const merged = [
        ...(comments ?? []).map((c) => ({
          key: `comment-${c.id}`,
          type: 'comment',
          created_at: c.created_at,
          postContent: contentById[c.post_id],
          detail: c.content,
        })),
        ...(reactions ?? []).map((r) => ({
          key: `reaction-${r.post_id}-${r.pseudo_id}-${r.created_at}`,
          type: 'reaction',
          created_at: r.created_at,
          postContent: contentById[r.post_id],
          detail: r.emoji,
        })),
      ]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 30)

      if (active) {
        setItems(merged)
        setLoading(false)
      }
    }

    load()
    return () => {
      active = false
    }
  }, [pseudoId, refreshSignal])

  if (loading) {
    return (
      <div className="space-y-2">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-xl border border-white/5 bg-base-900/40" />
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

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-white/5 bg-base-900/30 p-8 text-center text-sm text-zinc-500">
        No activity yet on your confessions. Comments and hearts you receive
        will show up here.
      </div>
    )
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.key} className="rounded-xl border border-white/5 bg-base-900/40 p-3 text-sm">
          <p className="text-zinc-300">
            {item.type === 'comment' ? (
              <>Someone commented: <span className="text-zinc-100">"{item.detail}"</span></>
            ) : (
              <>Someone reacted {item.detail} to your confession</>
            )}
          </p>
          {item.postContent && (
            <p dir={detectDirection(item.postContent)} className="mt-1 truncate text-xs text-zinc-500">
              {item.postContent}
            </p>
          )}
          <p className="mt-1 text-[11px] text-zinc-600">{timeAgo(item.created_at)}</p>
        </li>
      ))}
    </ul>
  )
}
