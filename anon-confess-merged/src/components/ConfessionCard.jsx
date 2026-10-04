import { useState, useEffect, useRef } from 'react'
import { supabase } from '../supabaseClient'
import { detectDirection } from '../lib/language'
import { getOwnerToken } from '../lib/pseudoId'
import { sharePost } from '../lib/share'
import ReactionBar from './ReactionBar'
import CommentThread from './CommentThread'
import Avatar from './Avatar'

const REPORT_REASONS = ['Spam', 'Harassment or hate', 'Self-harm concern', 'Other']

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

export default function ConfessionCard({ post, pseudoId, onBlocked, onDeleted, menuOpen, onToggleMenu, commentsOpen, onToggleComments, onOpenProfile, isAdmin, blockedIds, isSignedIn, onRequestSignIn }) {
  const [reportOpen, setReportOpen] = useState(false)
  const [reportSent, setReportSent] = useState(false)
  const [reportBusy, setReportBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState(null)
  const [linkCopied, setLinkCopied] = useState(false)

  const isOwnPost = post.pseudo_id === pseudoId
  // UX/SECURITY FIX (audit finding): showing "Delete" here whenever
  // pseudo_id matches, regardless of whether this browser actually has
  // an owner_token for THIS post, meant the button silently failed for
  // posts made before the owner_token system existed (pre-migration
  // legacy posts) or in the rare case localStorage was cleared/changed
  // browsers — clicking it always ended in the server's "owner token
  // required" error with nothing the user could do about it. A
  // signed-in account never needs the token (delete_own_post() verifies
  // ownership via auth.uid() instead), so it's exempt from this check.
  const canDelete = isOwnPost && (isSignedIn || Boolean(getOwnerToken(post.id)))
  const dir = detectDirection(post.content)

  // If another card's menu opens (parent closes ours), also collapse the
  // report-reasons submenu so it doesn't linger rendered on its own.
  useEffect(() => {
    if (!menuOpen) setReportOpen(false)
  }, [menuOpen])

  // Close the menu when tapping/clicking anywhere outside it.
  const menuRef = useRef(null)
  useEffect(() => {
    if (!menuOpen) return
    function handleOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onToggleMenu(null)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('touchstart', handleOutside)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('touchstart', handleOutside)
    }
  }, [menuOpen, onToggleMenu])

  const [reportError, setReportError] = useState(null)

  async function submitReport(reason) {
    setReportBusy(true)
    setReportError(null)
    const { error } = await supabase.from('reports').insert({
      post_id: post.id,
      reporter_pseudo_id: pseudoId,
      reason,
    })
    setReportBusy(false)
    setReportOpen(false)
    onToggleMenu(null)
    if (error) {
      // Either the per-target cap (section 21 — this account already has
      // plenty for an admin to review) or the per-reporter monthly cap
      // (section 22 — this browser/account has filed 30 in the last 30 days).
      let message = "Couldn't submit your report right now."
      if (error.message?.includes('report cap reached')) {
        message = 'This account already has the maximum number of open reports — an admin will review it soon.'
      } else if (error.message?.includes('reporter cap reached')) {
        message = "You've reached the monthly limit of 30 reports. Thanks for helping moderate — more openings free up as older reports age out."
      }
      setReportError(message)
      return
    }
    setReportSent(true)
  }

  function handleBlock() {
    onBlocked?.(post.pseudo_id)
    onToggleMenu(null)
  }

  async function handleShare() {
    const result = await sharePost(post.id, post.content)
    if (result === 'shared' || result === 'cancelled') return
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 1500)
  }

  async function handleDelete() {
    if (!window.confirm('Delete this confession? This cannot be undone.')) return
    setDeleteBusy(true)
    setDeleteError(null)
    const { error } = await supabase.rpc('delete_own_post', {
      p_post_id: post.id,
      p_pseudo_id: pseudoId,
      // Only meaningful for anonymous (not signed-in) posters — the server
      // ignores this for a signed-in account, which is verified by login
      // instead. Null here means "no token available" (e.g. an older post
      // made before this feature existed, or a different browser), and
      // the delete will correctly fail rather than silently allow it.
      p_owner_token: getOwnerToken(post.id),
    })
    setDeleteBusy(false)
    if (error) {
      setDeleteError("Couldn't delete this right now.")
      return
    }
    onToggleMenu(null)
    onDeleted?.(post.id)
  }

  return (
    <article className="relative animate-fade-up rounded-2xl border border-white/10 bg-base-900/50 p-4 sm:p-5 shadow-lg shadow-black/20">
      {/* soft gradient wash, purely decorative — rounded itself so it never
          needs overflow-hidden on the card (that would also clip the
          report/block dropdown menu below) */}
      <div
        className="pointer-events-none absolute inset-0 rounded-2xl opacity-40"
        style={{
          background:
            'radial-gradient(120% 100% at 100% 0%, rgba(111,116,201,0.18), transparent 60%), radial-gradient(100% 100% at 0% 100%, rgba(139,143,216,0.12), transparent 55%)',
        }}
      />

      <div className="relative">
        <p dir={dir} className="whitespace-pre-wrap text-[15px] leading-relaxed text-zinc-100">
          {post.content}
        </p>

        <div className="mt-4 h-px bg-white/10" />

        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs text-zinc-500 shrink-0">
            <Avatar pseudoId={post.pseudo_id} size={32} onClick={() => onOpenProfile?.(post.pseudo_id)} />
            <button
              type="button"
              onClick={() => onOpenProfile?.(post.pseudo_id)}
              className="font-medium text-hush-400 hover:text-hush-300 hover:underline"
            >
              {post.pseudo_id}
            </button>
            <span>{timeAgo(post.created_at)}</span>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onToggleComments(commentsOpen ? null : post.id)}
              aria-expanded={commentsOpen}
              aria-label="Comments"
              className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 0 1-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8Z" />
              </svg>
              <span className="tabular-nums">{post.comments_count || 0}</span>
            </button>
            <ReactionBar postId={post.id} pseudoId={pseudoId} initialCount={post.likes_count} />

            <div className="relative shrink-0" ref={menuRef}>
              <button
                type="button"
                onClick={() => onToggleMenu(menuOpen ? null : post.id)}
                aria-label="More options"
                className="text-zinc-600 hover:text-zinc-300 px-1"
              >
                ⋯
              </button>
              {menuOpen && (
                <div className="absolute bottom-full right-0 z-10 mb-1 w-40 rounded-lg border border-white/10 bg-base-800 py-1 text-xs shadow-lg">
                  <button
                    type="button"
                    onClick={handleShare}
                    className="block w-full px-3 py-1.5 text-left text-zinc-300 hover:bg-white/5"
                  >
                    {linkCopied ? 'Link copied' : 'Share'}
                  </button>
                  {!reportSent ? (
                    isSignedIn ? (
                      <button
                        type="button"
                        onClick={() => setReportOpen((v) => !v)}
                        className="block w-full px-3 py-1.5 text-left text-zinc-300 hover:bg-white/5"
                      >
                        Report
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          onToggleMenu(null)
                          onRequestSignIn?.()
                        }}
                        className="block w-full px-3 py-1.5 text-left text-zinc-500 hover:bg-white/5"
                        title="Sign in to report a post"
                      >
                        Sign in to report
                      </button>
                    )
                  ) : (
                    <span className="block px-3 py-1.5 text-zinc-500">Reported</span>
                  )}
                  {!isOwnPost && (
                    <button
                      type="button"
                      onClick={handleBlock}
                      className="block w-full px-3 py-1.5 text-left text-zinc-300 hover:bg-white/5"
                    >
                      Block {post.pseudo_id}
                    </button>
                  )}
                  {isOwnPost && !canDelete && (
                    <span
                      className="block px-3 py-1.5 text-[11px] text-zinc-600"
                      title="This post predates account-linked deletion and can no longer be self-deleted — contact an admin if it needs to come down."
                    >
                      Can't be deleted from here
                    </span>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      disabled={deleteBusy}
                      onClick={handleDelete}
                      className="block w-full px-3 py-1.5 text-left text-rose-400 hover:bg-white/5 disabled:opacity-40"
                    >
                      {deleteBusy ? 'Deleting…' : 'Delete'}
                    </button>
                  )}
                </div>
              )}
              {deleteError && (
                <p className="absolute bottom-full right-0 z-20 mb-1 w-40 rounded-lg border border-rose-500/20 bg-base-800 px-3 py-1.5 text-[11px] text-rose-400 shadow-lg">
                  {deleteError}
                </p>
              )}
              {reportError && (
                <p className="absolute bottom-full right-0 z-20 mb-1 w-48 rounded-lg border border-rose-500/20 bg-base-800 px-3 py-1.5 text-[11px] text-rose-400 shadow-lg">
                  {reportError}
                </p>
              )}
              {reportOpen && (
                <div className="absolute bottom-full right-0 z-20 mb-1 w-48 rounded-lg border border-white/10 bg-base-800 py-1 text-xs shadow-lg">
                  {REPORT_REASONS.map((reason) => (
                    <button
                      key={reason}
                      type="button"
                      disabled={reportBusy}
                      onClick={() => submitReport(reason)}
                      className="block w-full px-3 py-1.5 text-left text-zinc-300 hover:bg-white/5 disabled:opacity-40"
                    >
                      {reason}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <CommentThread postId={post.id} pseudoId={pseudoId} open={commentsOpen} onOpenProfile={onOpenProfile} isAdmin={isAdmin} isSignedIn={isSignedIn} blockedIds={blockedIds} />
      </div>
    </article>
  )
}
