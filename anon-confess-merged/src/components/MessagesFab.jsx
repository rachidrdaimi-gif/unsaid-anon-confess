import { useEffect, useState } from 'react'
import { supabase } from '../supabaseClient'
import { fetchUnreadCount } from '../lib/messages'

/** Floating "Messages" button with an unread badge. Only rendered for
 * signed-in accounts (App.jsx). `refreshKey` changes whenever the messages
 * panel closes so the badge updates right away after reading. */
export default function MessagesFab({ ownPseudoId, onOpen, refreshKey }) {
  const [count, setCount] = useState(0)

  useEffect(() => {
    let active = true
    const refresh = () =>
      fetchUnreadCount().then((n) => {
        if (active) setCount(n)
      })

    refresh()
    const channel = supabase
      .channel(`dm-fab:${ownPseudoId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'direct_messages' }, refresh)
      .subscribe()
    const t = setInterval(refresh, 30000)

    return () => {
      active = false
      supabase.removeChannel(channel)
      clearInterval(t)
    }
  }, [ownPseudoId, refreshKey])

  return (
    <button
      type="button"
      onClick={() => onOpen(null)}
      aria-label={count > 0 ? `Messages, ${count} unread` : 'Messages'}
      className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full border border-hush-500/40 bg-hush-600 text-white shadow-lg shadow-black/40 hover:bg-hush-500"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.6-.8L3 20l1.1-4.9A8.4 8.4 0 1 1 21 11.5Z"
        />
      </svg>
      {count > 0 && (
        <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-white">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  )
}
