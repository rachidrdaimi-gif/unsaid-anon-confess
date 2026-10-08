// End-to-end encryption for direct messages.
//
// How it works (all in the browser, WebCrypto — nothing to install):
//  * Every account has an ECDH P-256 key pair. The PUBLIC key is stored on
//    the server so others can write to you.
//  * The PRIVATE key never leaves your devices in readable form. It is
//    locked with a passphrase you choose (PBKDF2 + AES-GCM) and the locked
//    copy is stored on the server so you can unlock it on a new phone.
//  * Each conversation gets its own AES-256-GCM key, derived from your
//    private key + their public key (ECDH + HKDF). Both people derive the
//    same key, so both can read; the server only ever sees ciphertext.
//  * On this device the unlocked key lives in IndexedDB as a
//    non-extractable CryptoKey, so the passphrase is only needed once.
import { supabase } from '../supabaseClient'

const enc = new TextEncoder()
const dec = new TextDecoder()
const PREFIX = 'e2e1:'
const PBKDF2_ITERATIONS = 600000
const CURVE = { name: 'ECDH', namedCurve: 'P-256' }

export const LOCKED_TEXT = "🔒 Can't decrypt this message"

let activeUser = null
export function setActiveUser(pseudo) {
  activeUser = pseudo
}
export function getActiveUser() {
  return activeUser
}

// ---------- small helpers ----------
function b64(buf) {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}
function unb64(str) {
  const s = atob(str)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// ---------- device storage (IndexedDB, in-memory fallback) ----------
const mem = new Map()
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('unspoken-e2ee', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('keys')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function idbGet(key) {
  if (typeof indexedDB === 'undefined') return mem.get(key) ?? null
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const r = db.transaction('keys').objectStore('keys').get(key)
      r.onsuccess = () => resolve(r.result ?? null)
      r.onerror = () => reject(r.error)
    })
  } catch {
    return mem.get(key) ?? null
  }
}
async function idbSet(key, value) {
  mem.set(key, value)
  if (typeof indexedDB === 'undefined') return
  try {
    const db = await openDb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite')
      tx.objectStore('keys').put(value, key)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    /* kept in memory for this session only */
  }
}

// ---------- server calls ----------
async function fetchMyBundle() {
  const { data, error } = await supabase.rpc('my_key_bundle')
  if (error) throw new Error("Couldn't reach the server. Please try again.")
  const row = Array.isArray(data) ? data[0] : data
  return row && row.public_key ? row : null
}

const peerCache = new Map() // peer -> public key string
async function fetchPeerPublic(peer) {
  if (peerCache.has(peer)) return peerCache.get(peer)
  const { data, error } = await supabase.rpc('get_public_key', { p_pseudo: peer })
  if (error) throw new Error("Couldn't reach the server. Please try again.")
  if (!data) return null
  peerCache.set(peer, data)
  return data
}

// ---------- key setup / unlock ----------
async function passphraseKey(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// 'setup' (no keys yet) | 'locked' (keys exist, not unlocked here) | 'ready'
export async function getKeyState(own) {
  const bundle = await fetchMyBundle()
  if (!bundle) return 'setup'
  const local = await idbGet(own)
  return local && local.pub === bundle.public_key ? 'ready' : 'locked'
}

// Creates (or replaces) this account's keys. Replacing = old messages
// can no longer be read, so the UI warns before calling this a 2nd time.
export async function setupKeys(own, passphrase) {
  const pair = await crypto.subtle.generateKey(CURVE, true, ['deriveBits'])
  const pubJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const pub = JSON.stringify({ kty: pubJwk.kty, crv: pubJwk.crv, x: pubJwk.x, y: pubJwk.y })
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey)

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapKey = await passphraseKey(passphrase, salt)
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode('unspoken-key-v1|' + own) },
    wrapKey,
    pkcs8,
  )

  const { error } = await supabase.rpc('set_my_keys', {
    p_public: pub,
    p_wrapped: b64(wrapped),
    p_salt: b64(salt),
    p_iv: b64(iv),
  })
  if (error) throw new Error("Couldn't save your keys. Please try again.")

  const priv = await crypto.subtle.importKey('pkcs8', pkcs8, CURVE, false, ['deriveBits'])
  await idbSet(own, { priv, pub })
  clearCaches()
}

export async function unlockKeys(own, passphrase) {
  const bundle = await fetchMyBundle()
  if (!bundle) throw new Error('No keys found. Please set up encryption first.')
  let pkcs8
  try {
    const wrapKey = await passphraseKey(passphrase, unb64(bundle.salt))
    pkcs8 = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(bundle.iv), additionalData: enc.encode('unspoken-key-v1|' + own) },
      wrapKey,
      unb64(bundle.wrapped_private),
    )
  } catch {
    throw new Error('Wrong PIN. Please try again.')
  }
  const priv = await crypto.subtle.importKey('pkcs8', pkcs8, CURVE, false, ['deriveBits'])
  await idbSet(own, { priv, pub: bundle.public_key })
  clearCaches()
}

// ---------- per-conversation key ----------
const sharedCache = new Map()
function clearCaches() {
  sharedCache.clear()
  peerCache.clear()
}

async function sharedKey(own, peer) {
  const local = await idbGet(own)
  if (!local) throw new Error('Your messages are locked on this device.')
  const peerPub = await fetchPeerPublic(peer)
  if (!peerPub) {
    throw new Error("This person hasn't turned on encryption yet. Ask them to open Messages once.")
  }
  const cacheKey = `${own}|${peer}|${peerPub}|${local.pub}`
  if (sharedCache.has(cacheKey)) return sharedCache.get(cacheKey)

  const theirKey = await crypto.subtle.importKey('jwk', JSON.parse(peerPub), CURVE, false, [])
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirKey }, local.priv, 256)
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  const aes = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('unspoken-dm-v1') },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  sharedCache.set(cacheKey, aes)
  return aes
}

function aad(a, b) {
  return enc.encode('unspoken-dm|' + [a, b].sort().join('|'))
}

export async function encryptFor(own, peer, text) {
  const key = await sharedKey(own, peer)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(own, peer) },
    key,
    enc.encode(text),
  )
  return `${PREFIX}${b64(iv)}.${b64(ct)}`
}

// Returns readable text. Old plain-text messages (from before encryption
// existed) are returned as they are.
export async function decryptFrom(own, peer, content) {
  if (typeof content !== 'string' || !content.startsWith(PREFIX)) return content
  try {
    const [ivPart, ctPart] = content.slice(PREFIX.length).split('.')
    const key = await sharedKey(own, peer)
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(ivPart), additionalData: aad(own, peer) },
      key,
      unb64(ctPart),
    )
    return dec.decode(pt)
  } catch {
    return LOCKED_TEXT
  }
}

// Short code both people can compare (in person / another app) to be sure
// nobody swapped the keys. Same value on both sides.
export async function fingerprint(own, peer) {
  const local = await idbGet(own)
  const peerPub = await fetchPeerPublic(peer)
  if (!local || !peerPub) return null
  const parts = [local.pub, peerPub].sort().join('|')
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(parts)))
  const hex = Array.from(hash.slice(0, 10), (b) => b.toString(16).padStart(2, '0')).join('')
  return hex.match(/.{5}/g).join(' ')
}
