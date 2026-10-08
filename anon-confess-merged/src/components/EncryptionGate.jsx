import { useEffect, useState } from 'react'
import { getKeyState, setupKeys, unlockKeys, setActiveUser } from '../lib/e2ee'

// Digits only. 6 is the minimum: shorter PINs can be guessed far too easily.
const MIN_PIN = 6
const MAX_PIN = 12
const digitsOnly = (v) => v.replace(/\D/g, '').slice(0, MAX_PIN)

const shell = 'fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 sm:items-start sm:p-4'
const card =
  'flex h-dvh w-full max-w-xl flex-col border-white/10 bg-base-900 sm:mt-10 sm:h-[80vh] sm:rounded-2xl sm:border'
const input =
  'w-full rounded-xl border border-white/10 bg-base-850 px-4 py-2.5 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-hush-500/50'

/**
 * Shows the messages UI (children) only once this device holds the keys.
 * First time: choose a passphrase. New device: enter that passphrase.
 */
export default function EncryptionGate({ ownPseudoId, onClose, children }) {
  const [state, setState] = useState('checking') // checking | setup | locked | ready
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [restart, setRestart] = useState(false)

  useEffect(() => {
    setActiveUser(ownPseudoId)
    let cancelled = false
    getKeyState(ownPseudoId)
      .then((s) => !cancelled && setState(s))
      .catch((e) => {
        if (!cancelled) {
          setError(e.message)
          setState('error')
        }
      })
    return () => {
      cancelled = true
    }
  }, [ownPseudoId])

  if (state === 'ready') return children

  async function handleSetup(e) {
    e.preventDefault()
    if (pass.length < MIN_PIN) return setError(`Use at least ${MIN_PIN} digits.`)
    if (pass !== pass2) return setError("The two PINs don't match.")
    setBusy(true)
    setError(null)
    try {
      await setupKeys(ownPseudoId, pass)
      setState('ready')
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  async function handleUnlock(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await unlockKeys(ownPseudoId, pass)
      setState('ready')
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  const showSetup = state === 'setup' || (state === 'locked' && restart)

  return (
    <div className={shell}>
      <div className={card}>
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
          <h2 className="text-sm font-medium text-zinc-200">🔒 Private messages</h2>
          <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-300">
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {state === 'checking' && <p className="text-center text-xs text-zinc-600">Loading…</p>}

          {state === 'error' && <p className="text-xs text-rose-400">{error}</p>}

          {showSetup && (
            <form onSubmit={handleSetup} className="space-y-3">
              <p className="text-xs leading-relaxed text-zinc-400">
                Your messages are end-to-end encrypted: only you and the other person can read
                them. Choose a numeric PIN for this account. You'll need it on a new phone or
                after clearing your browser.
              </p>
              <p className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] leading-relaxed text-amber-300/80">
                {restart
                  ? 'Starting over creates new keys: your old messages will become unreadable.'
                  : 'If you forget your PIN, nobody can recover your old messages. Avoid obvious numbers like 123456 or your birth year.'}
              </p>
              <input
                type="password"
                value={pass}
                onChange={(e) => setPass(digitsOnly(e.target.value))}
                placeholder={`PIN (${MIN_PIN}-${MAX_PIN} digits)`}
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="new-password"
                className={input}
              />
              <input
                type="password"
                value={pass2}
                onChange={(e) => setPass2(digitsOnly(e.target.value))}
                placeholder="Repeat PIN"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="new-password"
                className={input}
              />
              {error && <p className="text-xs text-rose-400">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-full border border-hush-500/30 bg-hush-500/10 px-4 py-2.5 text-sm text-hush-300 hover:bg-hush-500/20 disabled:opacity-50"
              >
                {busy ? 'Creating keys…' : 'Turn on encryption'}
              </button>
              {restart && (
                <button
                  type="button"
                  onClick={() => {
                    setRestart(false)
                    setError(null)
                  }}
                  className="w-full text-xs text-zinc-500 hover:text-zinc-300"
                >
                  Back
                </button>
              )}
            </form>
          )}

          {state === 'locked' && !restart && (
            <form onSubmit={handleUnlock} className="space-y-3">
              <p className="text-xs leading-relaxed text-zinc-400">
                Enter your messages PIN to unlock your private messages on this device. You only
                need to do this once per device.
              </p>
              <input
                type="password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                placeholder="PIN"
                inputMode="numeric"
                autoComplete="current-password"
                className={input}
              />
              {error && <p className="text-xs text-rose-400">{error}</p>}
              <button
                type="submit"
                disabled={busy || !pass}
                className="w-full rounded-full border border-hush-500/30 bg-hush-500/10 px-4 py-2.5 text-sm text-hush-300 hover:bg-hush-500/20 disabled:opacity-50"
              >
                {busy ? 'Unlocking…' : 'Unlock'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRestart(true)
                  setError(null)
                  setPass('')
                }}
                className="w-full text-xs text-zinc-500 hover:text-zinc-300"
              >
                Forgot it? Start over
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
