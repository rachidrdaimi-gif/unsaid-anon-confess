import { supabase } from '../supabaseClient'

// Module-level cache shared by every <Avatar> on the page, so the same
// pseudo_id showing up on ten different posts only triggers one fetch —
// and so that right after uploading a new picture, every instance of your
// own avatar already on screen (your posts, your comments, the profile
// panel) updates immediately instead of waiting for a re-render/re-fetch.
const cache = new Map() // pseudo_id -> string | null
const pending = new Map() // pseudo_id -> Promise
const listeners = new Map() // pseudo_id -> Set<fn>

/** The folder this pseudo_id's avatar file lives under in the "avatars"
 * storage bucket. Mirrors pseudoIdToSyntheticEmail() in authIdentity.js —
 * same stripping, so both stay easy to reason about together. */
export function pseudoIdToFolder(pseudoId) {
  return pseudoId.replace('#', '').toLowerCase()
}

/** The single, fixed storage path a pseudo_id's avatar always lives at.
 * Every upload overwrites this same object — there
 * is never a second, orphaned file left behind after someone changes
 * their picture. */
export function avatarStoragePath(pseudoId) {
  return `${pseudoIdToFolder(pseudoId)}/avatar.jpg`
}

export function getCachedAvatar(pseudoId) {
  return cache.has(pseudoId) ? cache.get(pseudoId) : undefined
}

export function subscribeAvatar(pseudoId, fn) {
  if (!listeners.has(pseudoId)) listeners.set(pseudoId, new Set())
  listeners.get(pseudoId).add(fn)
  return () => listeners.get(pseudoId)?.delete(fn)
}

function notify(pseudoId) {
  listeners.get(pseudoId)?.forEach((fn) => fn(cache.get(pseudoId) ?? null))
}

/** Sets the cache immediately (e.g. right after this browser's own upload)
 * without waiting on a round trip to the database. */
export function setAvatarLocal(pseudoId, url) {
  cache.set(pseudoId, url)
  notify(pseudoId)
}

export async function fetchAvatar(pseudoId) {
  if (cache.has(pseudoId)) return cache.get(pseudoId)
  if (pending.has(pseudoId)) return pending.get(pseudoId)

  // SECURITY FIX (audit finding, section 28): this used to trust a raw
  // avatar_url string straight out of the database — set_own_avatar()
  // used to accept ANY url from the client with no validation, so a
  // malicious account could point their avatar at an attacker-controlled
  // tracking pixel, silently leaking every viewer's IP on an anonymous
  // site. avatar_path is now always a server-derived, known-safe path
  // (see set_own_avatar() in schema.sql), and the actual displayable URL
  // is built here via the SDK's own getPublicUrl() — which can only ever
  // point inside this project's own "avatars" bucket, never anywhere
  // else, regardless of what's stored in the row.
  const promise = supabase
    .from('avatars')
    .select('avatar_path, updated_at')
    .eq('pseudo_id', pseudoId)
    .maybeSingle()
    .then(({ data }) => {
      let url = null
      if (data?.avatar_path) {
        const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(data.avatar_path)
        const bust = data.updated_at ? new Date(data.updated_at).getTime() : Date.now()
        url = `${urlData.publicUrl}?v=${bust}`
      }
      cache.set(pseudoId, url)
      pending.delete(pseudoId)
      notify(pseudoId)
      return url
    })
    .catch(() => {
      pending.delete(pseudoId)
      return null
    })

  pending.set(pseudoId, promise)
  return promise
}
