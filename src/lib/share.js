/**
 * Shares a post's link. Prefers the OS-native share sheet (navigator.share
 * — WhatsApp, Telegram, Messages, etc. on mobile, and most desktop
 * browsers too) so posting an anonymous confession is actually easy to
 * pass along. Falls back to clipboard copy where the Web Share API isn't
 * available, and to a manual prompt() if even clipboard access fails.
 *
 * Never includes the poster's pseudo_id in the shared text — the link
 * itself is enough to open the post, and nothing here should nudge anyone
 * toward attaching an identity to an anonymous confession when sharing it
 * onward.
 */
export async function sharePost(postId, contentPreview) {
  const url = `${window.location.origin}${window.location.pathname}?post=${postId}`
  const text = contentPreview
    ? contentPreview.slice(0, 120) + (contentPreview.length > 120 ? '…' : '')
    : 'Someone shared this anonymously — take a look.'

  if (navigator.share) {
    try {
      await navigator.share({ title: 'Unspoken', text, url })
      return 'shared'
    } catch (err) {
      // AbortError just means the user closed the share sheet — not a
      // failure, don't fall back to clipboard in that case.
      if (err?.name === 'AbortError') return 'cancelled'
      // Any other error (unsupported data, etc.) — fall through and try
      // clipboard instead.
    }
  }

  try {
    await navigator.clipboard.writeText(url)
    return 'copied'
  } catch {
    window.prompt('Copy this link:', url)
    return 'prompted'
  }
}
