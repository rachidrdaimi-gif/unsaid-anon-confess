// Small UI tweaks applied after render.
// 1) Hides the "Create an account" heading in the auth modal (a label with no function).
// 2) Shows the signed-in / current user's profile picture inside the top "PROFILE" button.
import { getPseudoId } from './pseudoId.js'
import { fetchOwnPseudoId } from './authIdentity.js'
import { getCachedAvatar, fetchAvatar, subscribeAvatar } from './avatarCache.js'

const HIDDEN_HEADINGS = ['create an account']

function hideHeadings(root) {
  const nodes = root.querySelectorAll('h1, h2, h3, h4, p, span, div')
  nodes.forEach((el) => {
    if (el.dataset.tweakHidden || el.children.length > 0) return
    const text = (el.textContent || '').trim().toLowerCase()
    if (!HIDDEN_HEADINGS.includes(text)) return
    el.dataset.tweakHidden = '1'
    const parent = el.parentElement
    el.style.display = 'none'
    // keep the "Close" button on the right after the heading is gone
    if (parent && getComputedStyle(parent).display === 'flex') {
      parent.style.justifyContent = 'flex-end'
    }
  })
}

// ---- profile picture inside the PROFILE button ----
let trackedId = null
let unsubscribe = null
let avatarUrl = null
let ownId = null

// the signed-in identity can differ from the id cached in localStorage, so ask the app's own resolver
async function refreshOwnId() {
  try {
    const r = await fetchOwnPseudoId()
    const id = typeof r === 'string' ? r : (r && (r.pseudoId || r.pseudo_id || r.id)) || null
    if (id && id !== ownId) {
      ownId = id
      trackAvatarFor(ownId)
    }
  } catch (e) {
    // not signed in / resolver unavailable — fall back to the local pseudo id
    const fallbackId = getPseudoId()
    if (fallbackId && fallbackId !== ownId) {
      ownId = fallbackId
      trackAvatarFor(ownId)
    }
  }
}

function trackAvatarFor(id) {
  if (trackedId === id) return
  trackedId = id
  if (typeof unsubscribe === 'function') {
    unsubscribe()
    unsubscribe = null
  }
  avatarUrl = getCachedAvatar(id) || null
  applyAvatarToButton()
  fetchAvatar(id).then((url) => {
    if (trackedId !== id) return
    avatarUrl = url || null
    applyAvatarToButton()
  }).catch(() => {})
  if (typeof subscribeAvatar === 'function') {
    unsubscribe = subscribeAvatar(id, (url) => {
      if (trackedId !== id) return
      avatarUrl = url || null
      applyAvatarToButton()
    })
  }
}

function findProfileButton(root) {
  const candidates = root.querySelectorAll('button, a')
  for (const el of candidates) {
    const text = (el.textContent || '').trim().toLowerCase()
    if (text === 'profile') return el
  }
  return null
}

function applyAvatarToButton() {
  const btn = findProfileButton(document)
  if (!btn) return
  let img = btn.querySelector('img[data-tweak-avatar]')
  if (!avatarUrl) {
    if (img) img.remove()
    return
  }
  if (!img) {
    img = document.createElement('img')
    img.dataset.tweakAvatar = '1'
    img.style.width = '20px'
    img.style.height = '20px'
    img.style.borderRadius = '50%'
    img.style.objectFit = 'cover'
    img.style.marginRight = '6px'
    img.style.display = 'inline-block'
    img.style.verticalAlign = 'middle'
    btn.prepend(img)
  }
  if (img.src !== avatarUrl) img.src = avatarUrl
}

function runTweaks() {
  hideHeadings(document)
  applyAvatarToButton()
}

const observer = new MutationObserver(() => runTweaks())
observer.observe(document.documentElement, { childList: true, subtree: true })

refreshOwnId()
setInterval(refreshOwnId, 15000)
document.addEventListener('DOMContentLoaded', runTweaks)
runTweaks()
