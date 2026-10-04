import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
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

/**
 * Look up an account by its anonymous handle (or just part of it, e.g. the
 * digits) and jump straight to their public profile to see their latest
 * posts — for when you're looking for a specific person's account rather
 * than browsing the general feed. Backed by search_pseudo_ids() (schema.sql
 * section 23), which only aggregates pseudo_ids that are already public on
 * their posts — this doesn't surface anything new.
 */
export default function SearchPanel({ onOpenProfile }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [status, setStatus] = useState('idle') // idle | loading | done | error

  useEffect(() => {
    const trimmed = query.trim().replace(/^#/, '')
    if (trimmed.length < 2) {
      setResults([])
      setStatus('idle')
      return
    }
    let active = true
    setStatus('loading')
    // Debounced so we're not firing a request on every keystroke.
    const timer = setTimeout(() => {
      supabase
        .rpc('search_pseudo_ids', { query: trimmed })
        .then(({ data, error }) => {
          if (!active) return
          if (error) {
            setStatus('error')
            return
          }
          setResults(data || [])
          setStatus('done')
        })
    }, 300)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [query])

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="account-search" className="sr-only">
          Search for an account
        </label>
        <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-base-900/60 px-4 py-3">
          <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-zinc-500" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path strokeLinecap="round" d="m20 20-3.5-3.5" />
          </svg>
          <input
            id="account-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search an account — e.g. AnonUser4821"
            className="w-full bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            autoComplete="off"
          />
        </div>
        <p className="mt-2 px-1 text-xs text-zinc-500">
          Search by anonymous handle to find someone's profile and their latest posts.
        </p>
      </div>

      {status === 'loading' && <p className="px-1 text-xs text-zinc-500">Searching…</p>}
      {status === 'error' && (
        <p className="px-1 text-xs text-rose-400">Couldn't search right now. Please try again.</p>
      )}
      {status === 'done' && results.length === 0 && (
        <p className="px-1 text-xs text-zinc-500">No accounts match "{query.trim()}".</p>
      )}

      {results.length > 0 && (
        <div className="space-y-2">
          {results.map((r) => (
            <div
              key={r.pseudo_id}
              role="button"
              tabIndex={0}
              onClick={() => onOpenProfile(r.pseudo_id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onOpenProfile(r.pseudo_id)
              }}
              className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-white/10 bg-base-900/60 p-3 text-left hover:bg-white/5"
            >
              <Avatar pseudoId={r.pseudo_id} size={36} onClick={() => onOpenProfile(r.pseudo_id)} />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-zinc-100">{r.pseudo_id}</div>
                <div className="text-xs text-zinc-500">
                  {r.post_count} post{r.post_count === 1 ? '' : 's'} · last active {timeAgo(r.latest_post_at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
