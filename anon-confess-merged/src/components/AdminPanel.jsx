import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'

/**
 * Admin access is gated by a real signed-in account (checked server-side
 * against the `admins` table) — not a shared password. If you're not signed
 * in, or your account isn't listed as an admin, this just shows a message.
 * Three tabs: open Reports (dismiss / delete post / ban the author), Most
 * reported (accounts ranked by open-report count in the last 30 days — see
 * schema.sql section 21 for the 30-reports/30-days cap), and Banned
 * accounts (unban, or ban someone directly by pseudo_id).
 */
export default function AdminPanel({ onClose }) {
  const [status, setStatus] = useState('checking') // checking | denied | ready
  const [tab, setTab] = useState('reports') // reports | top | banned
  const [reports, setReports] = useState([])
  const [banned, setBanned] = useState([])
  const [bannedLoaded, setBannedLoaded] = useState(false)
  const [topReported, setTopReported] = useState([])
  const [topLoaded, setTopLoaded] = useState(false)
  const [error, setError] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [banBusyId, setBanBusyId] = useState(null)
  const [manualBanId, setManualBanId] = useState('')
  const [manualBanReason, setManualBanReason] = useState('')
  const [manualBanBusy, setManualBanBusy] = useState(false)
  const [manualBanError, setManualBanError] = useState(null)
  // Which top-reported account's "reported posts" panel is expanded, plus
  // per-account cache of its report details (post content + reason) so
  // re-expanding after collapsing doesn't re-fetch. null id = none open.
  const [expandedTopId, setExpandedTopId] = useState(null)
  const [topDetails, setTopDetails] = useState({})
  const [topDetailsBusyId, setTopDetailsBusyId] = useState(null)

  async function callAdmin(action, payload) {
    const { data, error: fnError } = await supabase.functions.invoke('admin-moderation', {
      body: { action, payload },
    })
    if (fnError) throw new Error(data?.error || fnError.message)
    return data
  }

  useEffect(() => {
    let active = true
    callAdmin('list_reports', {})
      .then((data) => {
        if (!active) return
        setReports(data.reports || [])
        setStatus('ready')
      })
      .catch((err) => {
        if (!active) return
        setError(err.message)
        setStatus('denied')
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (status !== 'ready' || tab !== 'banned' || bannedLoaded) return
    let active = true
    callAdmin('list_banned', {})
      .then((data) => {
        if (!active) return
        setBanned(data.banned || [])
        setBannedLoaded(true)
      })
      .catch((err) => {
        if (active) setError(err.message)
      })
    return () => {
      active = false
    }
  }, [status, tab, bannedLoaded])

  useEffect(() => {
    if (status !== 'ready' || tab !== 'top' || topLoaded) return
    let active = true
    callAdmin('list_top_reported', {})
      .then((data) => {
        if (!active) return
        setTopReported(data.accounts || [])
        setTopLoaded(true)
      })
      .catch((err) => {
        if (active) setError(err.message)
      })
    return () => {
      active = false
    }
  }, [status, tab, topLoaded])

  async function handleDismiss(reportId) {
    try {
      await callAdmin('dismiss_report', { report_id: reportId })
      setReports((prev) => prev.filter((r) => r.id !== reportId))
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleDeletePost(postId) {
    if (!window.confirm('Delete this post? This cannot be undone.')) return
    setDeletingId(postId)
    try {
      await callAdmin('delete_reported_post', { post_id: postId })
      setReports((prev) => prev.filter((r) => r.post_id !== postId))
    } catch (err) {
      setError(err.message)
    }
    setDeletingId(null)
  }

  // Shared by every ban entry point (report card, manual form, top-reported
  // row) so the Banned tab and the Most-reported tab's is_banned flag never
  // drift out of sync with each other, whichever screen triggered it.
  function markBannedLocally(pseudoId, reason) {
    setBanned((prev) => [
      { pseudo_id: pseudoId, reason: reason ?? null, banned_at: new Date().toISOString() },
      ...prev.filter((b) => b.pseudo_id !== pseudoId),
    ])
    setBannedLoaded(true)
    setTopReported((prev) =>
      prev.map((a) => (a.pseudo_id === pseudoId ? { ...a, is_banned: true, ban_reason: reason ?? null } : a))
    )
  }

  function markUnbannedLocally(pseudoId) {
    setBanned((prev) => prev.filter((b) => b.pseudo_id !== pseudoId))
    setTopReported((prev) =>
      prev.map((a) => (a.pseudo_id === pseudoId ? { ...a, is_banned: false, ban_reason: null } : a))
    )
  }

  async function handleBanAuthor(report) {
    const authorId = report.posts?.pseudo_id
    if (!authorId) return
    if (!window.confirm(`Ban ${authorId}? They won't be able to post or comment anymore.`)) return
    setBanBusyId(report.id)
    try {
      await callAdmin('ban_pseudo_id', { pseudo_id: authorId, reason: report.reason })
      markBannedLocally(authorId, report.reason)
    } catch (err) {
      setError(err.message)
    }
    setBanBusyId(null)
  }

  async function handleBanFromTop(account) {
    if (!window.confirm(`Ban ${account.pseudo_id}? They won't be able to post or comment anymore.`)) return
    setBanBusyId(account.pseudo_id)
    try {
      await callAdmin('ban_pseudo_id', { pseudo_id: account.pseudo_id })
      markBannedLocally(account.pseudo_id, null)
    } catch (err) {
      setError(err.message)
    }
    setBanBusyId(null)
  }

  // Powers the "Most reported" tab's link from an account to the actual
  // posts that were reported — lets a mod check the content itself before
  // banning, instead of banning on report count alone.
  async function handleToggleTopDetails(pseudoId) {
    if (expandedTopId === pseudoId) {
      setExpandedTopId(null)
      return
    }
    setExpandedTopId(pseudoId)
    if (topDetails[pseudoId]) return
    setTopDetailsBusyId(pseudoId)
    try {
      const data = await callAdmin('get_user_moderation_info', { pseudo_id: pseudoId })
      setTopDetails((prev) => ({ ...prev, [pseudoId]: data.reports || [] }))
    } catch (err) {
      setError(err.message)
    }
    setTopDetailsBusyId(null)
  }

  async function handleUnban(pseudoId) {
    setBanBusyId(pseudoId)
    try {
      await callAdmin('unban_pseudo_id', { pseudo_id: pseudoId })
      markUnbannedLocally(pseudoId)
    } catch (err) {
      setError(err.message)
    }
    setBanBusyId(null)
  }

  async function handleManualBan(e) {
    e.preventDefault()
    const targetId = manualBanId.trim()
    setManualBanError(null)
    if (!/^#AnonUser[0-9]{4,6}$/.test(targetId)) {
      setManualBanError('Enter a full id like #AnonUser1234.')
      return
    }
    setManualBanBusy(true)
    try {
      await callAdmin('ban_pseudo_id', { pseudo_id: targetId, reason: manualBanReason.trim() || null })
      markBannedLocally(targetId, manualBanReason.trim() || null)
      setManualBanId('')
      setManualBanReason('')
    } catch (err) {
      setManualBanError(err.message)
    }
    setManualBanBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 overflow-y-auto">
      <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-base-900 p-5 mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-200">Moderation panel</h2>
          <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-300">
            Close
          </button>
        </div>

        {status === 'checking' && (
          <p className="text-xs text-zinc-500">Checking access…</p>
        )}

        {status === 'denied' && (
          <p className="text-xs text-rose-400">
            {error || "You don't have access to this panel."} Sign in with your
            admin account first, then reopen this page.
          </p>
        )}

        {status === 'ready' && (
          <div className="space-y-3">
            {/* Reported people alongside previously banned people, in one
                place, so a mod can see what's outstanding and what action
                to take without cross-referencing two different screens. */}
            <div className="flex gap-1 rounded-full border border-white/10 bg-base-800 p-1 text-xs">
              <button
                type="button"
                onClick={() => setTab('reports')}
                className={`flex-1 rounded-full px-3 py-1.5 ${
                  tab === 'reports' ? 'bg-hush-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Reports {reports.length > 0 ? `(${reports.length})` : ''}
              </button>
              <button
                type="button"
                onClick={() => setTab('top')}
                className={`flex-1 rounded-full px-3 py-1.5 ${
                  tab === 'top' ? 'bg-hush-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Most reported {topLoaded && topReported.length > 0 ? `(${topReported.length})` : ''}
              </button>
              <button
                type="button"
                onClick={() => setTab('banned')}
                className={`flex-1 rounded-full px-3 py-1.5 ${
                  tab === 'banned' ? 'bg-hush-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Banned {bannedLoaded && banned.length > 0 ? `(${banned.length})` : ''}
              </button>
            </div>

            {error && <p className="text-xs text-rose-400">{error}</p>}

            {tab === 'reports' && (
              <div className="space-y-3">
                {reports.length === 0 && (
                  <p className="text-xs text-zinc-500">No open reports. All clear.</p>
                )}
                {reports.map((r) => {
                  const authorId = r.posts?.pseudo_id
                  const alreadyBanned = bannedLoaded && banned.some((b) => b.pseudo_id === authorId)
                  return (
                    <div key={r.id} className="rounded-xl border border-white/10 bg-base-800 p-3 text-sm">
                      <p className="text-zinc-200 whitespace-pre-wrap">{r.posts?.content}</p>
                      <div className="mt-2 text-xs text-zinc-500">
                        Author: <span className="text-hush-400">{authorId}</span> · Reported
                        by <span className="text-hush-400">{r.reporter_pseudo_id}</span> · Reason: {r.reason}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        <button
                          onClick={() => handleDismiss(r.id)}
                          className="rounded-full border border-white/10 px-3 py-1 text-zinc-300 hover:bg-white/5"
                        >
                          Dismiss (reviewed)
                        </button>
                        <button
                          onClick={() => handleDeletePost(r.post_id)}
                          disabled={deletingId === r.post_id}
                          className="rounded-full border border-rose-500/30 px-3 py-1 text-rose-400 hover:bg-rose-500/10 disabled:opacity-40"
                        >
                          {deletingId === r.post_id ? 'Deleting…' : 'Delete post'}
                        </button>
                        {authorId && (
                          <button
                            onClick={() => handleBanAuthor(r)}
                            disabled={banBusyId === r.id || alreadyBanned}
                            className="rounded-full border border-amber-500/30 px-3 py-1 text-amber-400 hover:bg-amber-500/10 disabled:opacity-40"
                          >
                            {alreadyBanned ? 'Already banned' : banBusyId === r.id ? 'Banning…' : `Ban ${authorId}`}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {tab === 'top' && (
              <div className="space-y-2">
                <p className="text-xs text-zinc-500">
                  Accounts with open reports in the last 30 days, ranked highest first — each
                  account can collect at most 30 before new reports against it stop being
                  accepted.
                </p>
                {!topLoaded && <p className="text-xs text-zinc-500">Loading…</p>}
                {topLoaded && topReported.length === 0 && (
                  <p className="text-xs text-zinc-500">No reported accounts right now.</p>
                )}
                {topLoaded &&
                  topReported.map((a) => (
                    <div
                      key={a.pseudo_id}
                      className="rounded-xl border border-white/10 bg-base-800 p-3 text-sm"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-hush-400">{a.pseudo_id}</span>
                            {a.is_banned && <span className="text-[10px] text-rose-400">banned</span>}
                          </div>
                          <div className="text-xs text-zinc-500">
                            Last reported {new Date(a.latest_report_at).toLocaleDateString()}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs tabular-nums ${
                              a.report_count >= 30
                                ? 'bg-rose-500/15 text-rose-400'
                                : 'bg-white/5 text-zinc-300'
                            }`}
                          >
                            {a.report_count}/30
                          </span>
                          {a.is_banned ? (
                            <button
                              onClick={() => handleUnban(a.pseudo_id)}
                              disabled={banBusyId === a.pseudo_id}
                              className="rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-300 hover:bg-white/5 disabled:opacity-40"
                            >
                              {banBusyId === a.pseudo_id ? '…' : 'Unban'}
                            </button>
                          ) : (
                            <button
                              onClick={() => handleBanFromTop(a)}
                              disabled={banBusyId === a.pseudo_id}
                              className="rounded-full border border-amber-500/30 px-3 py-1 text-xs text-amber-400 hover:bg-amber-500/10 disabled:opacity-40"
                            >
                              {banBusyId === a.pseudo_id ? '…' : 'Ban'}
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Links the leaderboard entry to the actual reported posts, so a
                          mod can read what was reported (and why) before acting on a
                          count alone. */}
                      <button
                        type="button"
                        onClick={() => handleToggleTopDetails(a.pseudo_id)}
                        className="mt-2 text-[11px] text-hush-400 hover:underline"
                      >
                        {expandedTopId === a.pseudo_id ? 'Hide reported posts' : 'View reported posts'}
                      </button>

                      {expandedTopId === a.pseudo_id && (
                        <div className="mt-2 space-y-2 border-t border-white/5 pt-2">
                          {topDetailsBusyId === a.pseudo_id && (
                            <p className="text-xs text-zinc-500">Loading…</p>
                          )}
                          {topDetailsBusyId !== a.pseudo_id && (topDetails[a.pseudo_id] || []).length === 0 && (
                            <p className="text-xs text-zinc-500">No open reports found for this account.</p>
                          )}
                          {(topDetails[a.pseudo_id] || []).map((r) => (
                            <div
                              key={r.id}
                              className="rounded-lg border border-white/5 bg-base-900 p-2 text-xs"
                            >
                              <div className="flex items-center justify-between gap-2 text-zinc-500">
                                <span>{r.reason}</span>
                                <span>{new Date(r.created_at).toLocaleDateString()}</span>
                              </div>
                              <p className="mt-1 whitespace-pre-wrap text-zinc-300">
                                {r.posts?.content || '(post no longer available)'}
                              </p>
                              <a
                                href={`${window.location.origin}${window.location.pathname}?post=${r.post_id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-1 inline-block text-hush-400 hover:underline"
                              >
                                Open post
                              </a>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            )}

            {tab === 'banned' && (
              <div className="space-y-3">
                <form onSubmit={handleManualBan} className="rounded-xl border border-white/10 bg-base-800 p-3 space-y-2">
                  <p className="text-xs text-zinc-500">Ban an account directly (not tied to an existing report)</p>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      value={manualBanId}
                      onChange={(e) => setManualBanId(e.target.value)}
                      placeholder="#AnonUser1234"
                      className="flex-1 rounded-lg border border-white/10 bg-base-900 px-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
                    />
                    <input
                      value={manualBanReason}
                      onChange={(e) => setManualBanReason(e.target.value)}
                      placeholder="Reason (optional)"
                      className="flex-1 rounded-lg border border-white/10 bg-base-900 px-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={manualBanBusy || !manualBanId.trim()}
                      className="rounded-full border border-amber-500/30 px-3 py-1.5 text-xs text-amber-400 hover:bg-amber-500/10 disabled:opacity-40"
                    >
                      {manualBanBusy ? 'Banning…' : 'Ban'}
                    </button>
                  </div>
                  {manualBanError && <p className="text-xs text-rose-400">{manualBanError}</p>}
                </form>

                {!bannedLoaded && <p className="text-xs text-zinc-500">Loading…</p>}
                {bannedLoaded && banned.length === 0 && (
                  <p className="text-xs text-zinc-500">No banned accounts.</p>
                )}
                {bannedLoaded &&
                  banned.map((b) => (
                    <div
                      key={b.pseudo_id}
                      className="flex items-center justify-between rounded-xl border border-white/10 bg-base-800 p-3 text-sm"
                    >
                      <div>
                        <div className="text-hush-400">{b.pseudo_id}</div>
                        <div className="text-xs text-zinc-500">
                          {b.reason ? `Reason: ${b.reason} · ` : ''}
                          Banned {new Date(b.banned_at).toLocaleDateString()}
                        </div>
                      </div>
                      <button
                        onClick={() => handleUnban(b.pseudo_id)}
                        disabled={banBusyId === b.pseudo_id}
                        className="rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-300 hover:bg-white/5 disabled:opacity-40"
                      >
                        {banBusyId === b.pseudo_id ? 'Unbanning…' : 'Unban'}
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
