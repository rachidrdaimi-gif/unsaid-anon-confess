import { useState } from 'react'
import { supabase } from '../supabaseClient'
import { moderateContent, needsSupportBanner } from '../lib/moderation'
import { checkPostRateLimit, recordPost } from '../lib/rateLimit'
import { detectDirection } from '../lib/language'
import { saveOwnerToken } from '../lib/pseudoId'
import { sharePost } from '../lib/share'

const MAX_CHARS = 500

export default function ConfessionForm({ pseudoId, onPosted }) {
  const [content, setContent] = useState('')
  const [status, setStatus] = useState({ type: 'idle' })
  const [showSupportNote, setShowSupportNote] = useState(false)
  const [justPosted, setJustPosted] = useState(null)
  const [shareCopied, setShareCopied] = useState(false)

  const remaining = MAX_CHARS - content.length
  const overLimit = remaining < 0

  function handleChange(e) {
    const value = e.target.value.slice(0, MAX_CHARS)
    setContent(value)
    setShowSupportNote(needsSupportBanner(value))
    if (status.type === 'error') setStatus({ type: 'idle' })
    if (justPosted) setJustPosted(null)
  }

  async function handleSubmit(e) {
    e.preventDefault()

    const moderation = moderateContent(content)
    if (!moderation.allowed) {
      setStatus({ type: 'error', message: moderation.reason })
      return
    }

    const rate = checkPostRateLimit()
    if (!rate.allowed) {
      setStatus({
        type: 'error',
        message: rate.waitSeconds
          ? `${rate.reason} (${rate.waitSeconds}s)`
          : rate.reason,
      })
      return
    }

    setStatus({ type: 'posting' })

    const ownerToken = crypto.randomUUID()

    const { data, error } = await supabase.rpc('create_post', {
      p_pseudo_id: pseudoId,
      p_content: content.trim(),
      p_owner_token: ownerToken,
    })

    if (error) {
      const friendly = error.message?.includes('rate limit')
        ? 'Slow down a little — try again shortly.'
        : "Couldn't post right now. Please try again."
      setStatus({ type: 'error', message: friendly })
      return
    }

    const postId = data?.[0]?.id
    if (postId) {
      saveOwnerToken(postId, ownerToken)
      setJustPosted({ id: postId, content: content.trim() })
    }

    recordPost()
    setContent('')
    setShowSupportNote(false)
    setStatus({ type: 'posted' })
    onPosted?.()
    setTimeout(() => setStatus({ type: 'idle' }), 2500)
  }

  async function handleShareJustPosted() {
    if (!justPosted) return
    const result = await sharePost(justPosted.id, justPosted.content)
    if (result === 'shared' || result === 'cancelled') return
    setShareCopied(true)
    setTimeout(() => setShareCopied(false), 1500)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-white/5 bg-base-900/60 p-4 sm:p-5 shadow-lg shadow-black/20 backdrop-blur"
    >
      <label htmlFor="confession" className="sr-only">
        Write what's on your mind
      </label>
      <textarea
        id="confession"
        value={content}
        onChange={handleChange}
        dir={detectDirection(content)}
        placeholder="Say the thing you haven't said out loud yet…"
        rows={4}
        maxLength={MAX_CHARS + 20}
        className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
      />

      {showSupportNote && (
        <p className="mb-3 rounded-lg border border-hush-500/30 bg-hush-500/10 px-3 py-2 text-xs leading-relaxed text-hush-400">
          That sounds heavy to carry. If you're in crisis, you don't have to
          face it alone — in the US you can call or text 988 (Suicide &amp;
          Crisis Lifeline), or find a local helpline at findahelpline.com.
        </p>
      )}

      <div className="flex items-center justify-between gap-3 pt-1">
        <span
          className={`text-xs tabular-nums ${
            overLimit ? 'text-rose-400' : 'text-zinc-500'
          }`}
        >
          {remaining}
        </span>

        <div className="flex items-center gap-3">
          {status.type === 'error' && (
            <span className="text-xs text-rose-400">{status.message}</span>
          )}
          {status.type === 'posted' && (
            <span className="text-xs text-hush-400">Shared, anonymously.</span>
          )}
          {justPosted && status.type !== 'posting' && (
            <button
              type="button"
              onClick={handleShareJustPosted}
              className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-white/5"
            >
              {shareCopied ? 'Link copied' : 'Share it'}
            </button>
          )}
          {!(justPosted && !content.trim()) && (
            <button
              type="submit"
              disabled={
                !content.trim() || overLimit || status.type === 'posting'
              }
              className="rounded-full bg-hush-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-hush-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status.type === 'posting' ? 'Sharing…' : 'Share anonymously'}
            </button>
          )}
        </div>
      </div>
    </form>
  )
}
