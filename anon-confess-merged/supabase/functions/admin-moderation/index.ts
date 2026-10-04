// supabase/functions/admin-moderation/index.ts
//
// Backs AdminPanel.jsx's supabase.functions.invoke('admin-moderation', ...).
// This file did not exist anywhere in the project before, so the admin
// panel could never work no matter what was in the `admins` table.
//
// Security model:
//   - The caller's JWT (forwarded automatically by supabase-js) is used to
//     look up their user id.
//   - That user id is checked against public.admins using the SERVICE ROLE
//     key, which bypasses RLS — this is the ONE place in the whole project
//     that is allowed to read/write admins/reports directly, and it never
//     runs in the browser.
//   - Anyone not signed in, or signed in but not listed in admins, gets a
//     403 and nothing else happens.
//
// Deploy with:
//   supabase functions deploy admin-moderation
// It automatically has access to SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// as built-in secrets — no manual `supabase secrets set` needed for those.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return json({ error: 'Missing Authorization header — please sign in.' }, 401)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

  // Client scoped to the caller's own JWT, only used to find out who they are.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const {
    data: { user },
    error: userError,
  } = await callerClient.auth.getUser()

  if (userError || !user) {
    return json({ error: 'Not signed in.' }, 401)
  }

  // Service-role client — bypasses RLS. Never expose this key to the browser.
  const adminClient = createClient(supabaseUrl, serviceRoleKey)

  const { data: adminRow } = await adminClient
    .from('admins')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!adminRow) {
    return json({ error: "You don't have access to this panel." }, 403)
  }

  let body: { action?: string; payload?: Record<string, unknown> }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid request body.' }, 400)
  }

  const { action, payload } = body

  if (action === 'list_reports') {
    const { data, error } = await adminClient
      .from('reports')
      .select('id, reason, reporter_pseudo_id, created_at, post_id, posts ( content, pseudo_id )')
      .eq('status', 'open')
      .order('created_at', { ascending: false })

    if (error) return json({ error: error.message }, 500)
    return json({ reports: data ?? [] })
  }

  if (action === 'dismiss_report') {
    const reportId = payload?.report_id
    if (!reportId || typeof reportId !== 'string') {
      return json({ error: 'report_id is required.' }, 400)
    }
    const { error } = await adminClient
      .from('reports')
      .update({ status: 'dismissed' })
      .eq('id', reportId)

    if (error) return json({ error: error.message }, 500)
    return json({ ok: true })
  }

  if (action === 'delete_reported_post' || action === 'delete_post') {
    const postId = payload?.post_id
    if (!postId || typeof postId !== 'string') {
      return json({ error: 'post_id is required.' }, 400)
    }
    // Deleting the post cascades (via the existing foreign keys) to its
    // comments, reactions, post_likes and reports rows — including the
    // very report that led here, so there's no separate report cleanup.
    const { error } = await adminClient
      .from('posts')
      .delete()
      .eq('id', postId)

    if (error) return json({ error: error.message }, 500)
    return json({ ok: true })
  }

  const PSEUDO_ID_RE = /^#AnonUser[0-9]{4,6}$/

  if (action === 'ban_pseudo_id') {
    const targetId = payload?.pseudo_id
    const reason = typeof payload?.reason === 'string' ? payload.reason.slice(0, 200) : null
    if (typeof targetId !== 'string' || !PSEUDO_ID_RE.test(targetId)) {
      return json({ error: 'A valid pseudo_id is required.' }, 400)
    }
    const { error } = await adminClient
      .from('banned_pseudo_ids')
      .upsert(
        { pseudo_id: targetId, reason, banned_by: user.id, banned_at: new Date().toISOString() },
        { onConflict: 'pseudo_id' }
      )

    if (error) return json({ error: error.message }, 500)
    return json({ ok: true })
  }

  if (action === 'unban_pseudo_id') {
    const targetId = payload?.pseudo_id
    if (typeof targetId !== 'string' || !PSEUDO_ID_RE.test(targetId)) {
      return json({ error: 'A valid pseudo_id is required.' }, 400)
    }
    const { error } = await adminClient
      .from('banned_pseudo_ids')
      .delete()
      .eq('pseudo_id', targetId)

    if (error) return json({ error: error.message }, 500)
    return json({ ok: true })
  }

  if (action === 'list_banned') {
    const { data, error } = await adminClient
      .from('banned_pseudo_ids')
      .select('pseudo_id, reason, banned_at')
      .order('banned_at', { ascending: false })

    if (error) return json({ error: error.message }, 500)
    return json({ banned: data ?? [] })
  }

  // Ranked view for the "Most reported" tab: every account with an open
  // report in the last 30 days, most-reported first — the actual ordering
  // is done in SQL (top_reported_accounts()), this just calls it.
  if (action === 'list_top_reported') {
    const { data, error } = await adminClient.rpc('top_reported_accounts')

    if (error) return json({ error: error.message }, 500)
    return json({ accounts: data ?? [] })
  }

  // Everything a moderator needs to decide what to do about one specific
  // account: how many (open) reports its posts have collected, the most
  // recent ones with their reasons, and whether it's already banned. Used
  // by ProfilePanel's admin-only section so a mod reviewing someone's
  // profile doesn't have to cross-reference the Reports tab by hand.
  if (action === 'get_user_moderation_info') {
    const targetId = payload?.pseudo_id
    if (typeof targetId !== 'string' || !PSEUDO_ID_RE.test(targetId)) {
      return json({ error: 'A valid pseudo_id is required.' }, 400)
    }

    const [reportsRes, banRes] = await Promise.all([
      adminClient
        .from('reports')
        // Includes the reported post's own content (not just its author's
        // pseudo_id) so the admin panel's "Most reported" tab can show what
        // was actually reported, inline, next to each report reason —
        // instead of a mod having to cross-reference the post id by hand.
        .select('id, reason, status, created_at, post_id, posts!inner ( content, pseudo_id )')
        .eq('posts.pseudo_id', targetId)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(20),
      adminClient
        .from('banned_pseudo_ids')
        .select('pseudo_id, reason, banned_at')
        .eq('pseudo_id', targetId)
        .maybeSingle(),
    ])

    if (reportsRes.error) return json({ error: reportsRes.error.message }, 500)

    return json({
      reports: reportsRes.data ?? [],
      report_count: (reportsRes.data ?? []).length,
      ban: banRes.data ?? null,
    })
  }

  return json({ error: `Unknown action: ${action}` }, 400)
})
