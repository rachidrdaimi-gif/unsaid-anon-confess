import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import { signOut } from '../lib/authIdentity'
import { compressImage } from '../lib/imageCompress'
import { avatarStoragePath, setAvatarLocal } from '../lib/avatarCache'
import Avatar from './Avatar'
import ConfessionCard from './ConfessionCard'


function buildEngagementSeries(posts) {
  const days = []
  const today = new Date()
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    days.push({ key: d.toISOString().slice(0, 10), total: 0 })
  }
  const byKey = Object.fromEntries(days.map((d) => [d.key, d]))
  posts.forEach((post) => {
    const key = post.created_at.slice(0, 10)
    if (byKey[key]) byKey[key].total += post.likes_count || 0
  })
  return days
}

function EngagementChart({ posts }) {
  const series = buildEngagementSeries(posts)
  const max = Math.max(1, ...series.map((d) => d.total))
  return (
    <div className="flex items-end gap-1 h-20">
      {series.map((d) => (
        <div key={d.key} className="flex-1 flex flex-col items-center justify-end h-full">
          <div
            className="w-full rounded-sm bg-hush-500/60"
            style={{ height: `${(d.total / max) * 100}%`, minHeight: d.total > 0 ? '3px' : '1px' }}
            title={`${d.key}: ${d.total} reaction${d.total === 1 ? '' : 's'}`}
          />
        </div>
      ))}
    </div>
  )
}

// Client-side ceiling before we even try to compress — no point decoding a
// 40MB photo just to find out it won't fit. The real, unspoofable limit is
// the storage bucket's file_size_limit (1MB) enforced server-side.
const MAX_SOURCE_BYTES = 10 * 1024 * 1024

/**
 * Shows a pseudo_id's public profile: their picture (if any), stats, and
 * every confession that pseudo_id has posted. `pseudoId` is always the
 * profile being looked at; `ownPseudoId` is this browser's own id, used
 * to tell whether it's a look-in-the-mirror view (own profile controls:
 * avatar upload, sign-in/out, blocked list) or someone else's.
 * Posts are rendered with the exact same ConfessionCard used in the main
 * feed, so reacting, commenting, sharing, reporting, and blocking all work
 * identically here — nothing about interacting with a post changes just
 * because it was reached through a profile instead of the feed. Opened
 * from the PROFILE button in TopNav (own profile) or by tapping any
 * pseudo_id / avatar anywhere in the app (App.jsx's onOpenProfile).
 */
export default function ProfilePanel({
  pseudoId,
  ownPseudoId,
  isSignedIn,
  onClose,
  onRequestSignIn,
  refreshSignal,
  blockedIds,
  onUnblock,
  onBlock,
  isAdmin,
  onOpenProfile,
  onMessage,
}) {
  const isOwnProfile = pseudoId === ownPseudoId

  const [posts, setPosts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Same per-card open/closed tracking ConfessionFeed uses, so only one
  // post's menu or comment thread is expanded at a time on this screen too.
  const [openMenuPostId, setOpenMenuPostId] = useState(null)
  const [openCommentsPostId, setOpenCommentsPostId] = useState(null)

  // Admin-only: this account's open reports + ban status, so a mod
  // reviewing a profile can decide what to do without leaving this panel.
  const [modInfo, setModInfo] = useState(null)
  const [modLoading, setModLoading] = useState(false)
  const [modError, setModError] = useState(null)
  const [modBusy, setModBusy] = useState(false)

  useEffect(() => {
    if (!isAdmin || isOwnProfile) {
      setModInfo(null)
      return
    }
    let active = true
    setModLoading(true)
    setModError(null)
    supabase.functions
      .invoke('admin-moderation', {
        body: { action: 'get_user_moderation_info', payload: { pseudo_id: pseudoId } },
      })
      .then(({ data, error: fnError }) => {
        if (!active) return
        if (fnError) {
          setModError(data?.error || fnError.message)
        } else {
          setModInfo(data)
        }
        setModLoading(false)
      })
    return () => {
      active = false
    }
  }, [isAdmin, isOwnProfile, pseudoId])

  async function callAdmin(action, payload) {
    const { data, error: fnError } = await supabase.functions.invoke('admin-moderation', {
      body: { action, payload },
    })
    if (fnError) throw new Error(data?.error || fnError.message)
    return data
  }

  async function handleModBan() {
    if (!window.confirm(`Ban ${pseudoId}? They won't be able to post or comment anymore.`)) return
    setModBusy(true)
    setModError(null)
    try {
      await callAdmin('ban_pseudo_id', { pseudo_id: pseudoId })
      setModInfo((prev) => ({ ...prev, ban: { pseudo_id: pseudoId, reason: null, banned_at: new Date().toISOString() } }))
    } catch (err) {
      setModError(err.message)
    }
    setModBusy(false)
  }

  async function handleModUnban() {
    setModBusy(true)
    setModError(null)
    try {
      await callAdmin('unban_pseudo_id', { pseudo_id: pseudoId })
      setModInfo((prev) => ({ ...prev, ban: null }))
    } catch (err) {
      setModError(err.message)
    }
    setModBusy(false)
  }

  const [avatarBusy, setAvatarBusy] = useState(false)
  const [avatarError, setAvatarError] = useState(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    supabase
      .from('posts')
      .select('id, created_at, content, pseudo_id, likes_count, comments_count')
      .eq('pseudo_id', pseudoId)
      .order('created_at', { ascending: false })
      .then(({ data, error: fetchError }) => {
        if (!active) return
        if (fetchError) setError("Couldn't load this profile right now.")
        else setPosts(data ?? [])
        setLoading(false)
      })
    return () => {
      active = false
    }
  }, [pseudoId, refreshSignal])

  // Mirrors ConfessionFeed's handleDeleted — a post deleted from here
  // (self-delete, or an admin's delete-reported-post) drops out of this
  // list immediately instead of waiting for the next refresh.
  function handleDeleted(postId) {
    setPosts((current) => current.filter((p) => p.id !== postId))
  }

  const totalReactions = posts.reduce((sum, p) => sum + (p.likes_count || 0), 0)
  const totalComments = posts.reduce((sum, p) => sum + (p.comments_count || 0), 0)

  async function handleAvatarPick(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // so choosing the same file again still fires this
    if (!file) return

    if (!file.type.startsWith('image/')) {
      setAvatarError('Please choose an image file.')
      return
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setAvatarError('That image is too large to use.')
      return
    }

    setAvatarBusy(true)
    setAvatarError(null)

    // Always the SAME path for this pseudo_id, upserted — there is only
    // ever one avatar object per account in storage, so changing your
    // picture fully replaces the old one instead of leaving it behind.
    const path = avatarStoragePath(pseudoId)

    const blob = await compressImage(file).catch(() => null)
    if (!blob) {
      setAvatarBusy(false)
      setAvatarError('Could not process that image.')
      return
    }

    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(path, blob, { upsert: true, cacheControl: '3600', contentType: 'image/jpeg' })

    if (uploadError) {
      setAvatarBusy(false)
      setAvatarError("Couldn't upload that image right now.")
      return
    }

    // SECURITY FIX (audit finding, section 28): set_own_avatar() no
    // longer takes a url — it derives the caller's own safe path
    // server-side, so there's nothing left for a caller to lie about.
    // We only need the returned path to build a fresh, cache-busted
    // display URL locally via the SDK's own getPublicUrl().
    const { data: safePath, error: rpcError } = await supabase.rpc('set_own_avatar')

    setAvatarBusy(false)
    if (rpcError) {
      setAvatarError("Couldn't save your profile picture.")
      return
    }

    const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(safePath)
    setAvatarLocal(pseudoId, `${urlData.publicUrl}?v=${Date.now()}`)
  }

  async function handleAvatarRemove() {
    setAvatarBusy(true)
    setAvatarError(null)

    // Delete the actual file, not just the database row that points to
    // it — otherwise the object just sits in storage forever, unused.
    await supabase.storage.from('avatars').remove([avatarStoragePath(pseudoId)])

    const { error: rpcError } = await supabase.rpc('remove_own_avatar')
    setAvatarBusy(false)
    if (rpcError) {
      setAvatarError("Couldn't remove your profile picture.")
      return
    }
    setAvatarLocal(pseudoId, null)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
      <div className="mt-10 w-full max-w-xl rounded-2xl border border-white/10 bg-base-900 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-200">
            {isOwnProfile ? 'Your profile' : 'Profile'}
          </h2>
          <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-300">
            Close
          </button>
        </div>

        <div className="mb-4 flex items-center gap-4">
          <div className="relative shrink-0">
            <Avatar pseudoId={pseudoId} size={56} />
            {isOwnProfile && isSignedIn && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={avatarBusy}
                aria-label="Change profile picture"
                className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-hush-600 text-white hover:bg-hush-500 disabled:opacity-40"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m-7-7h14" />
                </svg>
              </button>
            )}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-hush-400">{pseudoId}</div>
            {!isOwnProfile && (
              <button
                type="button"
                onClick={() => onMessage?.(pseudoId)}
                className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-hush-500/30 bg-hush-500/10 px-3 py-1 text-xs text-hush-300 hover:bg-hush-500/20"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7l9 6 9-6M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
                </svg>
                Message
              </button>
            )}
            {isOwnProfile && !isSignedIn && (
              <div className="text-xs text-zinc-500">Sign in to add a profile picture</div>
            )}
          </div>
        </div>

        {isOwnProfile && isSignedIn && (
          <div className="mb-4">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={handleAvatarPick}
            />
            <div className="flex items-center gap-3 text-xs">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={avatarBusy}
                className="text-hush-400 underline hover:text-hush-300 disabled:opacity-40"
              >
                {avatarBusy ? 'Uploading…' : 'Change picture'}
              </button>
              <button
                type="button"
                onClick={handleAvatarRemove}
                disabled={avatarBusy}
                className="text-zinc-500 underline hover:text-zinc-300 disabled:opacity-40"
              >
                Remove
              </button>
            </div>
            {avatarError && <p className="mt-1 text-xs text-rose-400">{avatarError}</p>}
          </div>
        )}

        <div className="mb-4 flex items-center gap-6 text-xs text-zinc-500">
          <div>
            <div className="text-lg font-medium text-zinc-100">{posts.length}</div>
            <div>confessions</div>
          </div>
          <div>
            <div className="text-lg font-medium text-zinc-100">{totalReactions}</div>
            <div>reactions received</div>
          </div>
          <div>
            <div className="text-lg font-medium text-zinc-100">{totalComments}</div>
            <div>comments received</div>
          </div>
        </div>

        {isOwnProfile && (
          isSignedIn ? (
            <div className="mb-4 flex items-center justify-between text-xs">
              <span className="text-zinc-500">
                Synced across devices as <span className="text-hush-400 font-medium">{pseudoId}</span>
              </span>
              <button onClick={() => signOut()} className="text-zinc-500 underline hover:text-zinc-300">
                Sign out
              </button>
            </div>
          ) : (
            <button
              onClick={onRequestSignIn}
              className="mb-4 w-full rounded-full border border-hush-500/30 bg-hush-500/10 px-4 py-2 text-xs text-hush-300 hover:bg-hush-500/20"
            >
              Sign in to keep {pseudoId} the same across devices
            </button>
          )
        )}

        {isAdmin && !isOwnProfile && (
          <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
            <div className="mb-2 text-xs font-medium text-amber-400">Moderator view — visible only to admins</div>
            {modLoading && <p className="text-xs text-zinc-500">Loading moderation info…</p>}
            {modError && <p className="text-xs text-rose-400">{modError}</p>}
            {!modLoading && modInfo && (
              <>
                <p className="text-xs text-zinc-400">
                  Open reports against this account: <span className="text-zinc-200">{modInfo.report_count ?? 0}</span>
                </p>
                {modInfo.reports?.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-[11px] text-zinc-500">
                    {modInfo.reports.slice(0, 5).map((r) => (
                      <li key={r.id}>· {r.reason}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-xs text-zinc-400">
                  Status:{' '}
                  {modInfo.ban ? (
                    <span className="text-rose-400">
                      Banned{modInfo.ban.reason ? ` (${modInfo.ban.reason})` : ''}
                    </span>
                  ) : (
                    <span className="text-zinc-200">Not banned</span>
                  )}
                </p>
                <button
                  type="button"
                  onClick={modInfo.ban ? handleModUnban : handleModBan}
                  disabled={modBusy}
                  className={`mt-2 w-full rounded-full border px-4 py-2 text-xs disabled:opacity-40 ${
                    modInfo.ban
                      ? 'border-white/10 text-zinc-300 hover:bg-white/5'
                      : 'border-amber-500/30 text-amber-400 hover:bg-amber-500/10'
                  }`}
                >
                  {modBusy ? 'Working…' : modInfo.ban ? `Unban ${pseudoId}` : `Ban ${pseudoId}`}
                </button>
              </>
            )}
          </div>
        )}

        <div className="mb-4">
          <div className="mb-1 text-xs text-zinc-500">Engagement, last 14 days</div>
          <EngagementChart posts={posts} />
        </div>

        {loading && <div className="h-16 animate-pulse rounded-xl border border-white/5 bg-base-900/40" />}
        {!loading && error && <p className="text-xs text-rose-400">{error}</p>}
        {!loading && !error && posts.length === 0 && (
          <p className="text-xs text-zinc-500">
            {isOwnProfile ? "You haven't shared anything yet." : "This account hasn't shared anything yet."}
          </p>
        )}
        {!loading && !error && posts.length > 0 && (
          <div className="space-y-2">
            {posts.map((post) => (
              <ConfessionCard
                key={post.id}
                post={post}
                pseudoId={ownPseudoId}
                onBlocked={onBlock}
                onDeleted={handleDeleted}
                menuOpen={openMenuPostId === post.id}
                onToggleMenu={setOpenMenuPostId}
                commentsOpen={openCommentsPostId === post.id}
                onToggleComments={setOpenCommentsPostId}
                onOpenProfile={onOpenProfile}
                isAdmin={isAdmin}
                blockedIds={blockedIds}
                isSignedIn={isSignedIn}
                onRequestSignIn={onRequestSignIn}
              />
            ))}
          </div>
        )}

        {isOwnProfile && (
          <div className="mt-5 border-t border-white/10 pt-4">
            <div className="mb-2 text-xs text-zinc-500">Blocked users</div>
            {!blockedIds || blockedIds.size === 0 ? (
              <p className="text-xs text-zinc-600">You haven't blocked anyone.</p>
            ) : (
              <ul className="space-y-1.5">
                {[...blockedIds].map((id) => (
                  <li key={id} className="flex items-center justify-between rounded-lg border border-white/5 bg-base-900/40 px-3 py-1.5 text-xs">
                    <span className="text-hush-400">{id}</span>
                    <button
                      type="button"
                      onClick={() => onUnblock?.(id)}
                      className="text-zinc-500 underline hover:text-zinc-300"
                    >
                      Unblock
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
