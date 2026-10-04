import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { moderateContent } from '../lib/moderation'
import { detectDirection } from '../lib/language'
import { saveCommentOwnerToken, getCommentOwnerToken } from '../lib/pseudoId'
import Avatar from './Avatar'

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

export default function CommentThread({ postId, pseudoId, open, onOpenProfile, isAdmin, isSignedIn, blockedIds }) {
  const [comments, setComments] = useState([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [error, setError] = useState(null)
  const [posting, setPosting] = useState(false)
  const [deletingId, setDeletingId] = useState(null)

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    supabase
      .from('comments')
      .select('id, pseudo_id, content, created_at')
      .eq('post_id', postId)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (!active) return
        setComments(data ?? [])
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, postId])

  async function handleSubmit(e) {
    e.preventDefault()
    const moderation = moderateContent(text.slice(0, 50))
    if (!moderation.allowed) {
      setError(moderation.reason)
      return
    }
    if (text.trim().length > 50) {
      setError('Comments are limited to 50 characters.')
      return
    }
    setPosting(true)
    setError(null)

    // SECURITY FIX (audit finding, section 26): comments used to be a
    // direct client insert with pseudo_id taken at face value — since
    // pseudo_id is public, anyone could insert a comment under someone
    // else's pseudo_id. create_comment() registers a per-comment owner
    // token atomically, same pattern as create_post(), so this browser
    // can later prove it actually posted this comment.
    const ownerToken = crypto.randomUUID()
    const trimmed = text.trim()

    const { data, error: rpcError } = await supabase
      .rpc('create_comment', {
        p_post_id: postId,
        p_pseudo_id: pseudoId,
        p_content: trimmed,
        p_owner_token: ownerToken,
      })
      .single()

    if (rpcError) {
      setError(
        rpcError.message?.includes('rate limit')
          ? rpcError.message.includes('daily')
            ? "You've reached today's limit of 2 comments. Try again tomorrow."
            : 'Slow down a little — try again shortly.'
          : "Couldn't post your comment right now."
      )
    } else {
      saveCommentOwnerToken(data.id, ownerToken)
      setComments((prev) => [
        ...prev,
        { id: data.id, pseudo_id: pseudoId, content: trimmed, created_at: data.created_at },
      ])
      setText('')
    }
    setPosting(false)
  }

  async function handleDelete(comment) {
    if (!window.confirm('Delete this comment? This cannot be undone.')) return
    setDeletingId(comment.id)
    setError(null)
    // p_pseudo_id is this browser's own id — used to prove ownership for a
    // regular delete. If the caller is an admin, the server ignores it and
    // allows the delete regardless of who actually posted the comment.
    // p_owner_token is the secret this browser registered when it created
    // the comment (see handleSubmit) — required for an anonymous caller to
    // delete their own comment; ignored server-side for signed-in/admin
    // callers.
    const { error: rpcError } = await supabase.rpc('delete_comment', {
      p_comment_id: comment.id,
      p_pseudo_id: pseudoId,
      p_owner_token: getCommentOwnerToken(comment.id),
    })
    setDeletingId(null)
    if (rpcError) {
      setError("Couldn't delete that comment right now.")
      return
    }
    setComments((prev) => prev.filter((c) => c.id !== comment.id))
  }

  if (!open) return null

  // Blocking someone hides their comments too, not just their posts —
  // this only affects what renders locally, never what's stored.
  const blocked = blockedIds ?? new Set()
  const visibleComments = comments.filter((c) => !blocked.has(c.pseudo_id))

  return (
    <div className="mt-3 border-t border-white/5 pt-3 space-y-2">
      {loading && <div className="h-6 w-24 animate-pulse rounded bg-white/5" />}

      {!loading &&
        visibleComments.map((c) => {
          // UX/SECURITY FIX (audit finding): same issue as the post
          // delete button — showing this for any own-pseudo_id comment
          // regardless of whether this browser actually holds that
          // specific comment's owner_token meant it always failed for
          // comments made before section 26 shipped. Signed-in accounts
          // are exempt (delete_comment() verifies them via auth.uid()
          // instead of the token).
          const canDelete =
            isAdmin || (c.pseudo_id === pseudoId && (isSignedIn || Boolean(getCommentOwnerToken(c.id))))
          return (
            <div key={c.id} className="flex items-start gap-2 group">
              <Avatar pseudoId={c.pseudo_id} size={28} onClick={() => onOpenProfile?.(c.pseudo_id)} className="mt-0.5" />
              <div className="flex-1 min-w-0">
                <button
                  type="button"
                  onClick={() => onOpenProfile?.(c.pseudo_id)}
                  className="text-xs font-medium text-hush-400 hover:text-hush-300 hover:underline"
                >
                  {c.pseudo_id}
                </button>{' '}
                <span className="text-zinc-500 text-[11px]">{timeAgo(c.created_at)}</span>
                <p dir={detectDirection(c.content)} className="text-sm text-zinc-200 whitespace-pre-wrap">
                  {c.content}
                </p>
              </div>
              {canDelete && (
                <button
                  type="button"
                  onClick={() => handleDelete(c)}
                  disabled={deletingId === c.id}
                  aria-label="Delete comment"
                  className="shrink-0 text-[11px] text-zinc-600 hover:text-rose-400 disabled:opacity-40"
                >
                  {deletingId === c.id ? '…' : '✕'}
                </button>
              )}
            </div>
          )
        })}

      {!loading && visibleComments.length === 0 && (
        <p className="text-xs text-zinc-500">No comments yet.</p>
      )}

      <form onSubmit={handleSubmit} className="flex items-center gap-2 pt-1">
        <span className="text-[10px] text-zinc-600 tabular-nums">{50 - text.length}</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 50))}
          dir={detectDirection(text)}
          placeholder="Write a comment…"
          className="flex-1 rounded-full border border-white/10 bg-base-800 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!text.trim() || posting}
          className="rounded-full bg-hush-600 px-3 py-1.5 text-xs text-white hover:bg-hush-500 disabled:opacity-40"
        >
          Post
        </button>
      </form>
      {error && <p className="text-xs text-rose-400">{error}</p>}
    </div>
  )
}
