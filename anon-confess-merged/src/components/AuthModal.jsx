import { useEffect, useRef, useState } from 'react'
import {
  signInWithGoogle,
  signInWithEmail,
  signUpWithEmail,
  signInWithPseudoId,
  signUpWithPseudoId,
  requestPasswordReset,
  updatePassword,
} from '../lib/authIdentity'
import { getAnyOwnershipProof } from '../lib/pseudoId'

// SECURITY FIX (audit finding, item 4): Cloudflare Turnstile widget for
// every credentialed auth action (sign-in, sign-up, password-reset
// request) — the ones that hit Supabase's public GoTrue endpoints and so
// can't be rate-limited from our own database (see the note in
// authIdentity.js). This alone does nothing until
// VITE_TURNSTILE_SITE_KEY is set (see .env.example) AND Supabase
// Dashboard -> Authentication -> Attack Protection has Turnstile turned
// on with the matching secret key.
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY

function useTurnstile(active) {
  const containerRef = useRef(null)
  const widgetIdRef = useRef(null)
  const [token, setToken] = useState(null)

  useEffect(() => {
    if (!active || !TURNSTILE_SITE_KEY) return undefined

    let cancelled = false
    let pollId = null

    function render() {
      if (cancelled || !containerRef.current || !window.turnstile) return
      if (widgetIdRef.current !== null) return
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (t) => setToken(t),
        'expired-callback': () => setToken(null),
        'error-callback': () => setToken(null),
      })
    }

    if (window.turnstile) {
      render()
    } else {
      // The script tag in index.html loads with async/defer, so it may
      // not be ready yet on first mount — poll briefly rather than
      // requiring a specific load order.
      pollId = window.setInterval(() => {
        if (window.turnstile) {
          window.clearInterval(pollId)
          render()
        }
      }, 200)
    }

    return () => {
      cancelled = true
      if (pollId) window.clearInterval(pollId)
      if (widgetIdRef.current !== null && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current)
      }
      widgetIdRef.current = null
    }
  }, [active])

  function reset() {
    setToken(null)
    if (widgetIdRef.current !== null && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current)
    }
  }

  return { containerRef, token, reset }
}

export default function AuthModal({ onClose, currentPseudoId, initialMode }) {
  const [method, setMethod] = useState('pseudo') // 'pseudo' | 'email'
  // 'signin' | 'signup' | 'forgot' (request reset email) | 'reset' (set new
  // password — only reached via initialMode, after the emailed link lands
  // the user back here with an active Supabase recovery session).
  const [mode, setMode] = useState(initialMode === 'reset' ? 'reset' : 'signup')
  const [pseudoId, setPseudoId] = useState(currentPseudoId || '')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [info, setInfo] = useState(null)
  const [busy, setBusy] = useState(false)

  // 'reset' doesn't touch GoTrue's public sign-in/sign-up endpoints (it
  // uses the already-authenticated recovery session), so it needs no
  // CAPTCHA.
  const needsCaptcha = mode !== 'reset'
  const captcha = useTurnstile(needsCaptcha && Boolean(TURNSTILE_SITE_KEY))

  async function handleGoogle() {
    setError(null)
    setBusy(true)
    try {
      await signInWithGoogle()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setBusy(true)
    try {
      if (mode === 'forgot') {
        await requestPasswordReset(email, captcha.token)
        setInfo('If that email has an account, a reset link is on its way.')
      } else if (mode === 'reset') {
        await updatePassword(password)
        setInfo('Password updated — you can keep using the app.')
        setTimeout(onClose, 1500)
      } else if (method === 'pseudo') {
        if (mode === 'signup') {
          await signUpWithPseudoId(pseudoId, password, getAnyOwnershipProof(), captcha.token)
          setInfo('Account created — you can sign in now.')
          setMode('signin')
        } else {
          await signInWithPseudoId(pseudoId, password, captcha.token)
          onClose()
        }
      } else {
        if (mode === 'signup') {
          await signUpWithEmail(email, password, captcha.token)
          setInfo('Check your email to confirm your account, then sign in.')
        } else {
          await signInWithEmail(email, password, captcha.token)
          onClose()
        }
      }
    } catch (err) {
      setError(err.message)
    }
    // Turnstile tokens are single-use regardless of outcome — always
    // reset so the next attempt gets a fresh one.
    captcha.reset()
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-base-900 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-200">
            {mode === 'signup' && 'Create an account'}
            {mode === 'signin' && 'Sign in'}
            {mode === 'forgot' && 'Reset your password'}
            {mode === 'reset' && 'Choose a new password'}
          </h2>
          <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-300">
            Close
          </button>
        </div>

        {(mode === 'signup' || mode === 'signin') && (
          <button
            type="button"
            onClick={handleGoogle}
            disabled={busy}
            className="mb-3 flex w-full items-center justify-center gap-2 rounded-full border border-white/10 bg-base-800 px-3 py-2 text-sm text-zinc-300 hover:border-white/20 hover:text-white disabled:opacity-40"
          >
            <svg viewBox="0 0 18 18" className="h-4 w-4">
              <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.56 2.7-3.87 2.7-6.62Z" />
              <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.9v2.33A9 9 0 0 0 9 18Z" />
              <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.66 9c0-.59.1-1.16.29-1.7V4.97H.9A9 9 0 0 0 0 9c0 1.45.35 2.83.9 4.03l3.05-2.33Z" />
              <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .9 4.97l3.05 2.33C4.66 5.17 6.65 3.58 9 3.58Z" />
            </svg>
            Continue with Google
          </button>
        )}

        {(mode === 'signup' || mode === 'signin') && (
          <div className="mb-3 flex rounded-full border border-white/10 bg-base-800 p-1 text-xs">
            <button
              type="button"
              onClick={() => { setMethod('pseudo'); setError(null); setInfo(null) }}
              className={`flex-1 rounded-full py-1.5 ${method === 'pseudo' ? 'bg-hush-600 text-white' : 'text-zinc-400'}`}
            >
              Anonymous ID
            </button>
            <button
              type="button"
              onClick={() => { setMethod('email'); setError(null); setInfo(null) }}
              className={`flex-1 rounded-full py-1.5 ${method === 'email' ? 'bg-hush-600 text-white' : 'text-zinc-400'}`}
            >
              Email
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-2">
          {mode === 'forgot' && (
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              className="w-full rounded-lg border border-white/10 bg-base-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            />
          )}

          {(mode === 'signup' || mode === 'signin') && (
            method === 'pseudo' ? (
              <input
                type="text"
                required
                pattern="#AnonUser[0-9]{4,6}"
                value={pseudoId}
                onChange={(e) => setPseudoId(e.target.value)}
                placeholder="#AnonUser1234"
                className="w-full rounded-lg border border-white/10 bg-base-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
              />
            ) : (
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                className="w-full rounded-lg border border-white/10 bg-base-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
              />
            )
          )}

          {(mode === 'signup' || mode === 'signin' || mode === 'reset') && (
            <input
              type="password"
              required
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password (min. 10 characters)"
              className="w-full rounded-lg border border-white/10 bg-base-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            />
          )}

          {method === 'email' && mode === 'signin' && (
            <button
              type="button"
              onClick={() => { setMode('forgot'); setError(null); setInfo(null) }}
              className="block text-left text-[11px] text-zinc-500 hover:text-zinc-300"
            >
              Forgot password?
            </button>
          )}

          {error && <p className="text-xs text-rose-400">{error}</p>}
          {info && <p className="text-xs text-hush-400">{info}</p>}

          {needsCaptcha && TURNSTILE_SITE_KEY && (
            <div ref={captcha.containerRef} className="flex justify-center py-1" />
          )}

          <button
            type="submit"
            disabled={busy || (needsCaptcha && Boolean(TURNSTILE_SITE_KEY) && !captcha.token)}
            className="w-full rounded-full bg-hush-600 px-4 py-2 text-sm font-medium text-white hover:bg-hush-500 disabled:opacity-40"
          >
            {busy
              ? 'Please wait…'
              : mode === 'signup'
                ? 'Create account'
                : mode === 'forgot'
                  ? 'Send reset link'
                  : mode === 'reset'
                    ? 'Update password'
                    : 'Sign in'}
          </button>
        </form>

        {(mode === 'signup' || mode === 'signin') && (
          <button
            type="button"
            onClick={() => {
              setMode((m) => (m === 'signup' ? 'signin' : 'signup'))
              setError(null)
              setInfo(null)
            }}
            className="mt-3 w-full text-center text-xs text-zinc-500 hover:text-zinc-300"
          >
            {mode === 'signup' ? 'Already have an account? Sign in' : "New here? Create an account"}
          </button>
        )}

        {mode === 'forgot' && (
          <button
            type="button"
            onClick={() => { setMode('signin'); setError(null); setInfo(null) }}
            className="mt-3 w-full text-center text-xs text-zinc-500 hover:text-zinc-300"
          >
            Back to sign in
          </button>
        )}

        {(mode === 'signup' || mode === 'signin') && (
          <p className="mt-3 text-center text-[11px] text-zinc-600">
            {method === 'pseudo'
              ? 'Claim your current anonymous id with a password so it stays the same on other devices.'
              : 'Your email is never shown publicly or attached to anything you post.'}
          </p>
        )}

        {mode === 'forgot' && (
          <p className="mt-3 text-center text-[11px] text-zinc-600">
            Password recovery only works for accounts made with the Email option — an Anonymous ID has no email attached to send a reset link to.
          </p>
        )}
      </div>
    </div>
  )
}
