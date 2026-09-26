import { supabase } from '../supabaseClient'

function friendlyAuthError(rawMessage) {
  const msg = (rawMessage || '').toLowerCase()

  if (msg.includes('provider is not enabled') || msg.includes('unsupported provider')) {
    return "Google sign-in isn't turned on for this site yet. You can still post anonymously — no account needed."
  }
  if (msg.includes('popup') || msg.includes('cancelled') || msg.includes('closed')) {
    return 'Sign-in was cancelled. No worries — try again whenever you like.'
  }
  if (msg.includes('invalid login credentials')) {
    return 'Incorrect email or password.'
  }
  if (msg.includes('email not confirmed') || msg.includes('email_not_confirmed')) {
    return "This account hasn't been confirmed yet. Please contact the site admin."
  }
  if (msg.includes('user already registered')) {
    return 'An account already exists with that email — try signing in instead.'
  }
  if (msg.includes('password') && msg.includes('least')) {
    // FIX: this used to hardcode "at least 10 characters" — but that is
    // only true if the Supabase Dashboard -> Authentication -> Policies
    // "Minimum password length" setting has actually been raised to 10 to
    // match the <input minLength={10}> in AuthModal.jsx. If that dashboard
    // setting is still at its default (6), the server's real error says
    // "Password should be at least 6 characters", and this used to show
    // the user a wrong number — which reads as "I typed a long enough
    // password and it still says it's too short", i.e. login/signup
    // looking broken when it wasn't. Now we pull the real number straight
    // out of the server's own message instead of guessing it.
    const digits = rawMessage.match(/\d+/)
    return digits
      ? `Password must be at least ${digits[0]} characters.`
      : 'Password is too short.'
  }
  if (msg.includes('network') || msg.includes('fetch')) {
    return 'Could not reach the server right now. Check your connection and try again.'
  }
  return "Couldn't sign in right now. Please try again in a moment."
}

export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  })
  if (error) throw new Error(friendlyAuthError(error.message))
}

export async function signUpWithEmail(email, password, captchaToken) {
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: { captchaToken },
  })
  if (error) throw new Error(friendlyAuthError(error.message))
}

export async function signInWithEmail(email, password, captchaToken) {
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
    options: { captchaToken },
  })
  if (error) throw new Error(friendlyAuthError(error.message))
}

// SECURITY FIX (audit finding, item 4 — CAPTCHA now wired up):
// This derives the login email deterministically from the pseudo_id —
// and the pseudo_id is PUBLIC, printed on every post and comment the
// account has ever made. That means the "username" half of this login
// is not a secret for any registered account: anyone who wants to target
// a specific poster can compute their exact sign-in email from a post
// they made, then run password guesses against it. A generic anon-only
// visitor is unaffected (no account exists to attack), but the moment
// someone uses "Claim your anonymous id with a password", their identity
// gains a guessable-username, password-only login.
//
// captchaToken (from the Turnstile widget in AuthModal.jsx) is now sent
// on every sign-in/sign-up below — but it only has teeth once Supabase
// Dashboard -> Authentication -> Attack Protection has Turnstile turned
// on with the matching secret key; the token is silently ignored by
// Supabase otherwise. Two more manual steps still recommended, since
// neither can be done from application code:
//   1. Dashboard -> Authentication -> Rate Limits: lower the sign-in
//      attempt rate limit from its default.
//   2. Dashboard -> Authentication -> Attack Protection: turn on Leaked
//      Password Protection.
function pseudoIdToSyntheticEmail(pseudoId) {
  return `${pseudoId.replace('#', '').toLowerCase()}@unspoken.local`
}

export async function signUpWithPseudoId(pseudoId, password, proof, captchaToken) {
  const { error } = await supabase.auth.signUp({
    email: pseudoIdToSyntheticEmail(pseudoId),
    password,
    // SECURITY FIX (audit finding): proof (from getAnyOwnershipProof() in
    // pseudoId.js) shows the server this browser actually authored a post
    // or comment under pseudoId — required by handle_new_user() when that
    // id already has public content, so a stranger can't claim an id they
    // merely saw on the feed. Harmless/ignored for a brand-new id.
    options: {
      captchaToken,
      data: {
        requested_pseudo_id: pseudoId,
        proof_post_id: proof?.postId ?? null,
        proof_post_owner_token: proof?.postOwnerToken ?? null,
        proof_comment_id: proof?.commentId ?? null,
        proof_comment_owner_token: proof?.commentOwnerToken ?? null,
      },
    },
  })
  if (error) {
    const msg = (error.message || '').toLowerCase()
    // Note: Supabase's auth server usually wraps a failed post-signup
    // trigger (see handle_new_user() in schema.sql) as a generic
    // "Database error saving new user" rather than passing our raised
    // message through verbatim — so this matches broadly rather than on
    // the exact Postgres exception text.
    if (
      msg.includes('id already has posts or comments') ||
      (msg.includes('database error') && msg.includes('saving new user'))
    ) {
      throw new Error(
        "This id already has posts or comments from someone else — you can only claim an id you've personally posted or commented under."
      )
    }
    throw new Error(friendlyAuthError(error.message))
  }
}

export async function signInWithPseudoId(pseudoId, password, captchaToken) {
  const { error } = await supabase.auth.signInWithPassword({
    email: pseudoIdToSyntheticEmail(pseudoId),
    password,
    options: { captchaToken },
  })
  if (error) {
    if (error.message?.toLowerCase().includes('invalid login credentials')) {
      throw new Error('Incorrect id or password.')
    }
    throw new Error(friendlyAuthError(error.message))
  }
}

export async function requestPasswordReset(email, captchaToken) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
    captchaToken,
  })
  if (error) throw new Error(friendlyAuthError(error.message))
}

export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) throw new Error(friendlyAuthError(error.message))
}

export async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) throw new Error("Couldn't sign out — please try again.")
}

export async function fetchOwnPseudoId(userId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await supabase
      .from('profiles')
      .select('pseudo_id')
      .eq('user_id', userId)
      .maybeSingle()

    if (!error && data?.pseudo_id) return data.pseudo_id
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return null
}
