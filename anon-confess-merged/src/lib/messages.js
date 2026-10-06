import { supabase } from '../supabaseClient'
import { encryptFor, decryptFrom, getActiveUser } from './e2ee'

// Turns the database's raw error text into something a person can act on.
function friendlyMessageError(error) {
  const msg = (error?.message || '').toLowerCase()
  if (msg.includes('content not allowed')) {
    return "That message has wording this space doesn't allow. Please rephrase it."
  }
  if (msg.includes('slow down')) {
    return msg.includes('new conversations')
      ? "You've started a lot of new conversations today. Try again tomorrow."
      : "You're sending messages very quickly. Please wait a bit and try again."
  }
  if (msg.includes("can't receive messages")) {
    return "This person can't receive messages right now."
  }
  if (msg.includes('banned')) {
    return 'This account has been restricted by a moderator.'
  }
  if (msg.includes('sign in')) {
    return 'Please sign in to send messages.'
  }
  if (msg.includes('must be encrypted')) {
    return 'Please refresh the app to update it, then try again.'
  }
  if (msg.includes('too long')) {
    return 'That message is too long.'
  }
  if (msg.includes('1 to 1000')) {
    return 'Messages must be between 1 and 1000 characters.'
  }
  return "Couldn't complete that right now. Please try again."
}

export async function fetchConversations() {
  const { data, error } = await supabase.rpc('my_conversations')
  if (error) throw new Error(friendlyMessageError(error))
  const own = getActiveUser()
  // Previews are decrypted here, on this device — the server only has ciphertext.
  return Promise.all(
    (data ?? []).map(async (c) => ({
      ...c,
      last_content: await decryptFrom(own, c.other_pseudo, c.last_content),
    })),
  )
}

export async function fetchThread(otherPseudo) {
  const { data, error } = await supabase.rpc('get_conversation', {
    p_other: otherPseudo,
    p_limit: 200,
  })
  if (error) throw new Error(friendlyMessageError(error))
  const own = getActiveUser()
  return Promise.all(
    (data ?? []).map(async (m) => ({
      ...m,
      content: await decryptFrom(own, otherPseudo, m.content),
    })),
  )
}

export async function sendMessage(otherPseudo, content) {
  const encrypted = await encryptFor(getActiveUser(), otherPseudo, content)
  const { error } = await supabase.rpc('send_direct_message', {
    p_to: otherPseudo,
    p_content: encrypted,
  })
  if (error) throw new Error(friendlyMessageError(error))
}

export async function markConversationRead(otherPseudo) {
  await supabase.rpc('mark_conversation_read', { p_other: otherPseudo })
}

export async function fetchUnreadCount() {
  const { data, error } = await supabase.rpc('unread_message_count')
  if (error) return 0
  return Number(data) || 0
}

export async function canMessage(otherPseudo) {
  const { data, error } = await supabase.rpc('pseudo_accepts_messages', { p_pseudo: otherPseudo })
  if (error) return false
  return Boolean(data)
}

export async function isBlockingMessagesFrom(otherPseudo) {
  const { data, error } = await supabase.rpc('am_i_blocking_messages_from', { p_pseudo: otherPseudo })
  if (error) return false
  return Boolean(data)
}

export async function setMessageBlock(otherPseudo, blocked) {
  const { error } = await supabase.rpc('set_message_block', {
    p_pseudo: otherPseudo,
    p_blocked: blocked,
  })
  if (error) throw new Error(friendlyMessageError(error))
}
