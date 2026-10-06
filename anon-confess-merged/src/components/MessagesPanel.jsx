import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'
import { detectDirection } from '../lib/language'
import {
  fetchConversations,
  fetchThread,
  sendMessage,
  markConversationRead,
  canMessage,
  isBlockingMessagesFrom,
  setMessageBlock,
} from '../lib/messages'
import Avatar from './Avatar'
import EncryptionGate from './EncryptionGate'
import { fingerprint } from '../lib/e2ee'

const PSEUDO_RE = /^#AnonUser[0-9]{4,6}$/
const MAX_LEN = 100

function timeAgo(isoString) {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000)
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * Private messages between registered accounts. Opens either on the list of
 * conversations, or straight into one (initialPeer) when reached from the
 * "Message" button on someone's profile. Only rendered for signed-in users
 * (App.jsx), and every read/write is re-checked server-side (schema.sql
 * section 32) — nothing here is trusted for access control.
 */
export default function MessagesPanel({ ownPseudoId, initialPeer, onClose }) {
  const [peer, setPeer] = useState(initialPeer ?? null)

  return (
    <EncryptionGate ownPseudoId={ownPseudoId} onClose={onClose}>
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 sm:items-start sm:p-4">
      <div className="flex h-dvh w-full max-w-xl flex-col border-white/10 bg-base-900 sm:mt-10 sm:h-[80vh] sm:rounded-2xl sm:border">
        {peer ? (
          <Thread
            key={peer}
            ownPseudoId={ownPseudoId}
            peer={peer}
            onBack={() => setPeer(null)}
            onClose={onClose}
          />
        ) : (
          <ConversationList onOpen={setPeer} onClose={onClose} />
        )}
      </div>
    </div>
    </EncryptionGate>
  )
}

function ConversationList({ onOpen, onClose }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [newId, setNewId] = useState('')
  const [newIdError, setNewIdError] = useState(null)

  const load = useCallback(async () => {
    try {
      setItems(await fetchConversations())
      setError(null)
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [load])

  function handleStart(e) {
    e.preventDefault()
    let value = newId.trim()
    if (value && !value.startsWith('#')) value = `#${value}`
    if (!PSEUDO_RE.test(value)) {
      setNewIdError('Enter an id like #AnonUser123456')
      return
    }
    setNewIdError(null)
    onOpen(value)
  }

  return (
    <>
      <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
        <h2 className="text-sm font-medium text-zinc-200">Messages</h2>
        <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-300">
          Close
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <p className="mb-4 rounded-xl border border-white/5 bg-base-850 p-3 text-[11px] leading-relaxed text-zinc-500">
          Talk privately with other people here — share what you're going through and be kind.
          Messages are end-to-end encrypted: only the two of you can read them. If you or someone
          you're talking to may be in danger, please contact your local emergency services.
        </p>

        <form onSubmit={handleStart} className="mb-4">
          <div className="flex gap-2">
            <input
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              placeholder="Message someone by id, e.g. #AnonUser123456"
              className="min-w-0 flex-1 rounded-full border border-white/10 bg-base-850 px-4 py-2 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-hush-500/50"
            />
            <button
              type="submit"
              className="shrink-0 rounded-full border border-hush-500/30 bg-hush-500/10 px-4 py-2 text-xs text-hush-300 hover:bg-hush-500/20"
            >
              Start
            </button>
          </div>
          {newIdError && <p className="mt-1 px-2 text-[11px] text-rose-400">{newIdError}</p>}
        </form>

        {loading && (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-xl bg-base-850" />
            ))}
          </div>
        )}

        {error && <p className="text-xs text-rose-400">{error}</p>}

        {!loading && !error && items.length === 0 && (
          <p className="py-8 text-center text-sm text-zinc-500">
            No conversations yet. Tap a name or picture on any confession, open their profile, and
            press Message.
          </p>
        )}

        <ul className="space-y-1">
          {items.map((c) => (
            <li key={c.other_pseudo} className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-base-850">
              <Avatar pseudoId={c.other_pseudo} size={40} onClick={() => onOpen(c.other_pseudo)} />
              <button
                type="button"
                onClick={() => onOpen(c.other_pseudo)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-hush-400">{c.other_pseudo}</span>
                  <span className="shrink-0 text-[11px] text-zinc-600">{timeAgo(c.last_at)}</span>
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span
                    dir={detectDirection(c.last_content)}
                    className={`truncate text-xs ${c.unread_count > 0 ? 'text-zinc-200' : 'text-zinc-500'}`}
                  >
                    {c.last_from_me ? 'You: ' : ''}
                    {c.last_content}
                  </span>
                  {c.unread_count > 0 && (
                    <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-hush-500 px-1.5 text-[10px] font-medium text-white">
                      {c.unread_count}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

function Thread({ ownPseudoId, peer, onBack, onClose }) {
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [accepting, setAccepting] = useState(true)
  const [iBlocked, setIBlocked] = useState(false)
  const [blockBusy, setBlockBusy] = useState(false)
  const [fp, setFp] = useState(null)
  const bottomRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const rows = await fetchThread(peer)
      setMessages(rows)
      if (rows.some((m) => m.recipient_pseudo === ownPseudoId && !m.read_at)) {
        markConversationRead(peer).catch(() => {})
      }
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }, [peer, ownPseudoId])

  useEffect(() => {
    load()
    canMessage(peer).then(setAccepting)
    fingerprint(ownPseudoId, peer).then(setFp).catch(() => setFp(null))
    isBlockingMessagesFrom(peer).then(setIBlocked)

    // Live updates, with a slow poll as a safety net in case realtime
    // isn't enabled for the table yet.
    const channel = supabase
      .channel(`dm-thread:${ownPseudoId}:${peer}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'direct_messages' }, (payload) => {
        if (payload.new?.sender_pseudo === peer) load()
      })
      .subscribe()
    const t = setInterval(load, 15000)

    return () => {
      supabase.removeChannel(channel)
      clearInterval(t)
    }
  }, [load, peer, ownPseudoId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  async function handleSend(e) {
    e.preventDefault()
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    try {
      await sendMessage(peer, text)
      setDraft('')
      await load()
    } catch (err) {
      setError(err.message)
    }
    setSending(false)
  }

  async function handleToggleBlock() {
    const next = !iBlocked
    if (next && !window.confirm(`Block ${peer}? You won't receive their messages, and they won't be able to message you.`)) {
      return
    }
    setBlockBusy(true)
    setError(null)
    try {
      await setMessageBlock(peer, next)
      setIBlocked(next)
      if (next) onBack()
    } catch (err) {
      setError(err.message)
    }
    setBlockBusy(false)
  }

  const canWrite = accepting && !iBlocked

  return (
    <>
      <div className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to conversations"
          className="text-zinc-500 hover:text-zinc-300"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <Avatar pseudoId={peer} size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-hush-400">{peer}</div>
          {fp && (
            <div className="truncate text-[10px] text-zinc-600" title="Compare this code with the other person to be sure nobody can intercept your messages">
              🔒 {fp}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={handleToggleBlock}
          disabled={blockBusy}
          className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
        >
          {iBlocked ? 'Unblock' : 'Block'}
        </button>
        <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-300">
          Close
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
        {loading && <p className="text-center text-xs text-zinc-600">Loading…</p>}

        {!loading && messages.length === 0 && (
          <p className="py-8 text-center text-sm text-zinc-500">
            Say hello — you can share what's on your mind.
          </p>
        )}

        {messages.map((m) => {
          const mine = m.sender_pseudo === ownPseudoId
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div
                dir={detectDirection(m.content)}
                className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm ${
                  mine ? 'rounded-br-md bg-hush-600 text-white' : 'rounded-bl-md bg-base-800 text-zinc-200'
                }`}
              >
                {m.content}
                <div className={`mt-1 text-[10px] ${mine ? 'text-white/60' : 'text-zinc-600'}`}>
                  {timeAgo(m.created_at)}
                </div>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-white/5 px-4 py-3">
        {error && <p className="mb-2 text-xs text-rose-400">{error}</p>}

        {!accepting && !iBlocked && (
          <p className="text-xs text-zinc-500">
            This person can't receive messages — they may not have an account, or they aren't
            accepting messages.
          </p>
        )}
        {iBlocked && (
          <p className="text-xs text-zinc-500">You blocked this person. Unblock them to write again.</p>
        )}

        {canWrite && (
          <form onSubmit={handleSend} className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, MAX_LEN))}
              dir={detectDirection(draft)}
              rows={2}
              placeholder="Write a message…"
              className="min-w-0 flex-1 resize-none rounded-2xl border border-white/10 bg-base-850 px-3.5 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-hush-500/50"
            />
            <button
              type="submit"
              disabled={sending || !draft.trim()}
              className="shrink-0 rounded-full bg-hush-600 px-4 py-2 text-xs font-medium text-white hover:bg-hush-500 disabled:opacity-40"
            >
              {sending ? '…' : 'Send'}
            </button>
          </form>
        )}
      </div>
    </>
  )
}
