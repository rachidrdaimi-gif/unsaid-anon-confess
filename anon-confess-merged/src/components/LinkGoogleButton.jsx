import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'

const ERR_KEY = 'unsaid_link_google_error'
const ALREADY_MSG = 'This Gmail is already linked to another account.'

// After Google redirects back, a failed link shows up in the URL. Capture it
// once at page load (the profile panel is closed by then), remember it, and
// clean the URL.
;(function captureLinkError() {
  try {
    const raw = window.location.hash.replace(/^#/, '') + '&' + window.location.search.replace(/^\?/, '')
    const params = new URLSearchParams(raw)
    const desc = params.get('error_description') || params.get('error_code') || params.get('error')
    if (!desc) return
    const msg = /already|exists|linked/i.test(desc) ? ALREADY_MSG : 'Could not link Gmail. Please try again.'
    window.sessionStorage.setItem(ERR_KEY, msg)
    window.history.replaceState(null, '', window.location.pathname)
    setTimeout(() => window.alert('✕ ' + msg), 800)
  } catch {
    /* ignore */
  }
})()

// Put <LinkGoogleButton /> inside the profile page, shown only when signed in.
// Requires in Supabase: Auth > Providers > Google enabled, and
// Auth > Sign In / Providers > "Allow manual linking" turned on.
export default function LinkGoogleButton() {
  const [email, setEmail] = useState(null) // linked Gmail, if any
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function refresh() {
    const { data } = await supabase.auth.getUserIdentities()
    const g = data?.identities?.find((i) => i.provider === 'google')
    setEmail(g?.identity_data?.email ?? null)
  }

  useEffect(() => {
    refresh()
    try {
      const saved = window.sessionStorage.getItem(ERR_KEY)
      if (saved) {
        setError(saved)
        window.sessionStorage.removeItem(ERR_KEY)
      }
    } catch {
      /* ignore */
    }
  }, [])

  async function link() {
    setBusy(true)
    setError(null)
    const { error: err } = await supabase.auth.linkIdentity({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
    if (err) {
      setError(
        /already|exists|linked/i.test(err.message)
          ? ALREADY_MSG
          : err.message,
      )
      setBusy(false)
    }
  }

  async function unlink() {
    setBusy(true)
    setError(null)
    const { data } = await supabase.auth.getUserIdentities()
    const g = data?.identities?.find((i) => i.provider === 'google')
    if (g) {
      const { error: err } = await supabase.auth.unlinkIdentity(g)
      if (err) setError(err.message)
    }
    await refresh()
    setBusy(false)
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-base-900/40 p-4 text-sm">
      {email ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-zinc-300">Linked Gmail: {email}</span>
          <button type="button" onClick={unlink} disabled={busy} className="text-xs text-rose-300 hover:text-rose-200">
            Unlink
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={link}
          disabled={busy}
          className="w-full rounded-full border border-white/10 px-4 py-2 text-zinc-200 hover:bg-white/5 disabled:opacity-50"
        >
          {busy ? '…' : 'Link my Gmail'}
        </button>
      )}
      {error && (
        <p className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          ✕ {error}
        </p>
      )}
    </div>
  )
}
