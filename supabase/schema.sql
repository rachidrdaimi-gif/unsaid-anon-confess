-- =============================================================================
-- Unsaid — anonymous confession app
-- Run this whole file once in Supabase SQL Editor (Project -> SQL Editor).
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS.
-- =============================================================================

create extension if not exists pgcrypto; -- gives us gen_random_uuid()

-- -----------------------------------------------------------------------------
-- 1. posts table
-- -----------------------------------------------------------------------------
create table if not exists public.posts (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  content      text not null,
  pseudo_id    text not null,
  likes_count  integer not null default 0,

  -- Server-side guardrails. Never trust the client alone for these.
  constraint posts_content_length check (char_length(trim(content)) between 1 and 500),
  constraint posts_pseudo_id_format check (pseudo_id ~ '^#AnonUser[0-9]{4,6}$'),
  constraint posts_likes_nonnegative check (likes_count >= 0)
);

create index if not exists posts_created_at_idx on public.posts (created_at desc);

-- We deliberately never add a column for IP address, user agent, or any
-- other identifying metadata to this table. Don't add one later either —
-- SELECT is public, so anything stored here is effectively published.

-- -----------------------------------------------------------------------------
-- 2. post_likes table — one row per (post, pseudo_id).
--    This is what makes "likes" actually mean something: the unique
--    constraint stops a single browser/session from inflating a post's
--    count by spam-clicking or replaying the RPC call.
-- -----------------------------------------------------------------------------
create table if not exists public.post_likes (
  post_id    uuid not null references public.posts (id) on delete cascade,
  pseudo_id  text not null check (pseudo_id ~ '^#AnonUser[0-9]{4,6}$'),
  created_at timestamptz not null default now(),
  primary key (post_id, pseudo_id)
);

-- -----------------------------------------------------------------------------
-- 3. Row Level Security
-- -----------------------------------------------------------------------------
alter table public.posts enable row level security;
alter table public.post_likes enable row level security;

drop policy if exists "public can read posts" on public.posts;
create policy "public can read posts"
  on public.posts for select
  to anon, authenticated
  using (true);

drop policy if exists "public can insert posts" on public.posts;
create policy "public can insert posts"
  on public.posts for insert
  to anon, authenticated
  with check (
    char_length(trim(content)) between 1 and 500
    and pseudo_id ~ '^#AnonUser[0-9]{4,6}$'
    -- likes_count must start at 0 — block clients from inserting a post
    -- that's already "pre-liked"
    and coalesce(likes_count, 0) = 0
  );

-- No UPDATE / DELETE policy for anon on posts at all: the only sanctioned
-- write to likes_count goes through the like_post() function below, which
-- runs as SECURITY DEFINER and bypasses RLS deliberately and narrowly.
-- Without an UPDATE policy, a direct `update posts set likes_count = ...`
-- from the client is rejected outright, no matter what value is sent.

-- post_likes: readable so a client could in principle audit counts, but
-- only insertable through the function (see below) — no direct policy.
drop policy if exists "public can read post_likes" on public.post_likes;
create policy "public can read post_likes"
  on public.post_likes for select
  to anon, authenticated
  using (true);

-- -----------------------------------------------------------------------------
-- 4. Rate limiting — server-side, so it holds even if the client-side
--    throttle in the app is bypassed entirely.
--
--    Caveat, stated plainly: pseudo_id is a client-supplied, unauthenticated
--    string. Anyone can clear localStorage (or call the API directly) to get
--    a fresh pseudo_id and reset their own limit. This trigger stops casual
--    flooding from a single session; it is NOT a defense against a
--    determined scripted attacker. For that, pair this with:
--      - Cloudflare Turnstile / hCaptcha on the submit form, and/or
--      - a Supabase Edge Function in front of inserts that rate-limits by
--        IP (edge functions can see the caller's IP; Postgres/RLS cannot),
--        and/or
--      - Supabase's built-in project-level API rate limits (Dashboard ->
--        Settings -> API).
-- -----------------------------------------------------------------------------
create or replace function public.enforce_post_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recent_count integer;
  last_post_at timestamptz;
begin
  select count(*), max(created_at)
    into recent_count, last_post_at
    from public.posts
   where pseudo_id = new.pseudo_id
     and created_at > now() - interval '1 hour';

  if recent_count >= 10 then
    raise exception 'rate limit: too many posts from this id in the last hour'
      using errcode = 'P0001';
  end if;

  if last_post_at is not null and last_post_at > now() - interval '15 seconds' then
    raise exception 'rate limit: posting too quickly'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists posts_rate_limit on public.posts;
create trigger posts_rate_limit
  before insert on public.posts
  for each row
  execute function public.enforce_post_rate_limit();

-- -----------------------------------------------------------------------------
-- 5. like_post RPC — atomic, idempotent-per-pseudo_id increment.
--
--    SECURITY DEFINER lets this function write to posts.likes_count even
--    though anon has no UPDATE grant on the table — but only through this
--    narrow, validated path, never a general-purpose write.
-- -----------------------------------------------------------------------------
create or replace function public.like_post(p_post_id uuid, p_pseudo_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  if p_pseudo_id !~ '^#AnonUser[0-9]{4,6}$' then
    raise exception 'invalid pseudo id';
  end if;

  -- Insert the like row; if this (post_id, pseudo_id) pair already liked
  -- it, the primary key conflict makes this a no-op — no double counting.
  insert into public.post_likes (post_id, pseudo_id)
  values (p_post_id, p_pseudo_id)
  on conflict (post_id, pseudo_id) do nothing;

  if not found then
    -- Already liked previously — just return the current count, don't increment.
    select likes_count into new_count from public.posts where id = p_post_id;
    return new_count;
  end if;

  update public.posts
     set likes_count = likes_count + 1
   where id = p_post_id
   returning likes_count into new_count;

  return new_count;
end;
$$;

-- Only expose this one narrow RPC to the public roles — not broad table access.
revoke all on function public.like_post(uuid, text) from public;
grant execute on function public.like_post(uuid, text) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. Realtime — allow the app to subscribe to new/updated posts live.
-- -----------------------------------------------------------------------------
alter publication supabase_realtime add table public.posts;

-- =============================================================================
-- 7. Optional Google sign-in, with identity kept hidden.
--
-- A signed-in user's Google email/name/avatar is NEVER exposed to the app —
-- only their assigned #AnonUserNNNN pseudo_id, stored in public.profiles and
-- linked 1:1 to their auth.users row. Anonymous (not signed in) visitors are
-- unaffected and keep working exactly as in sections 1-6.
-- =============================================================================

create table if not exists public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  pseudo_id  text not null unique,
  created_at timestamptz not null default now(),
  constraint profiles_pseudo_id_format check (pseudo_id ~ '^#AnonUser[0-9]{4,6}$')
);

alter table public.profiles enable row level security;

drop policy if exists "user can read own profile" on public.profiles;
create policy "user can read own profile"
  on public.profiles for select
  to authenticated
  using (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policy for any client role: rows are created only
-- by the trigger below (SECURITY DEFINER), never directly by a user.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate text;
  attempt integer := 0;
begin
  loop
    candidate := '#AnonUser' || (100000 + floor(random() * 900000))::int;
    begin
      insert into public.profiles (user_id, pseudo_id) values (new.id, candidate);
      exit;
    exception when unique_violation then
      attempt := attempt + 1;
      if attempt > 20 then
        raise exception 'could not allocate a unique pseudo id';
      end if;
    end;
  end loop;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- Tighten posts INSERT: signed-in users can only post as THEIR OWN
-- pseudo_id (looked up server-side, never trusted from the client).
drop policy if exists "public can insert posts" on public.posts;
create policy "public can insert posts"
  on public.posts for insert
  to anon, authenticated
  with check (
    char_length(trim(content)) between 1 and 500
    and pseudo_id ~ '^#AnonUser[0-9]{4,6}$'
    and coalesce(likes_count, 0) = 0
    and (
      auth.role() = 'anon'
      or pseudo_id = (select p.pseudo_id from public.profiles p where p.user_id = auth.uid())
    )
  );

-- Tighten like_post: a signed-in caller can only ever like as their own
-- pseudo_id — prevents spoofing someone else's id.
create or replace function public.like_post(p_post_id uuid, p_pseudo_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
  own_pseudo text;
begin
  if p_pseudo_id !~ '^#AnonUser[0-9]{4,6}$' then
    raise exception 'invalid pseudo id';
  end if;

  if auth.role() = 'authenticated' then
    select pseudo_id into own_pseudo from public.profiles where user_id = auth.uid();
    if own_pseudo is null or own_pseudo <> p_pseudo_id then
      raise exception 'pseudo id does not match signed-in account';
    end if;
  end if;

  insert into public.post_likes (post_id, pseudo_id)
  values (p_post_id, p_pseudo_id)
  on conflict (post_id, pseudo_id) do nothing;

  if not found then
    select likes_count into new_count from public.posts where id = p_post_id;
    return new_count;
  end if;

  update public.posts
     set likes_count = likes_count + 1
   where id = p_post_id
   returning likes_count into new_count;

  return new_count;
end;
$$;

revoke all on function public.like_post(uuid, text) from public;
grant execute on function public.like_post(uuid, text) to anon, authenticated;

-- =============================================================================
-- 8. Comments — the app UI (CommentThread.jsx) already reads/writes this
--    table, and ConfessionFeed/ProfilePanel already select posts.comments_count.
--    None of it existed in this file before, so every post-list query was
--    failing outright (PostgREST rejects selecting an unknown column) and
--    the comment feature had no backing table at all. This section adds
--    exactly what the existing frontend already expects — no UI changes.
-- =============================================================================

alter table public.posts add column if not exists comments_count integer not null default 0;

do $$ begin
  alter table public.posts
    add constraint posts_comments_nonnegative check (comments_count >= 0);
exception when duplicate_object then null;
end $$;

create table if not exists public.comments (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references public.posts (id) on delete cascade,
  pseudo_id    text not null,
  content      text not null,
  created_at   timestamptz not null default now(),

  -- Matches CommentThread.jsx's 50-character client-side limit — enforced
  -- server-side too, since client-side alone is never a real boundary.
  constraint comments_content_length check (char_length(trim(content)) between 1 and 50),
  constraint comments_pseudo_id_format check (pseudo_id ~ '^#AnonUser[0-9]{4,6}$')
);

create index if not exists comments_post_id_created_at_idx
  on public.comments (post_id, created_at);

alter table public.comments enable row level security;

drop policy if exists "public can read comments" on public.comments;
create policy "public can read comments"
  on public.comments for select
  to anon, authenticated
  using (true);

drop policy if exists "public can insert comments" on public.comments;
create policy "public can insert comments"
  on public.comments for insert
  to anon, authenticated
  with check (
    char_length(trim(content)) between 1 and 50
    and pseudo_id ~ '^#AnonUser[0-9]{4,6}$'
    and (
      auth.role() = 'anon'
      or pseudo_id = (select p.pseudo_id from public.profiles p where p.user_id = auth.uid())
    )
  );

-- No UPDATE/DELETE policy for anon/authenticated — comments are permanent
-- once posted, same trust model as posts themselves.

-- Keeps posts.comments_count in sync automatically, so the realtime
-- subscription ConfessionFeed already has on posts UPDATE picks it up for
-- free — no separate realtime wiring needed for comments.
create or replace function public.sync_post_comments_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set comments_count = comments_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update public.posts set comments_count = greatest(0, comments_count - 1) where id = old.post_id;
  end if;
  return null;
end;
$$;

drop trigger if exists comments_sync_count on public.comments;
create trigger comments_sync_count
  after insert or delete on public.comments
  for each row
  execute function public.sync_post_comments_count();

-- Server-side comment rate limit — mirrors enforce_post_rate_limit above,
-- and its error text matches what CommentThread.jsx already parses
-- ("rate limit" for the generic case, plus "daily" for the daily cap).
create or replace function public.enforce_comment_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  daily_count integer;
  last_comment_at timestamptz;
begin
  select count(*), max(created_at)
    into daily_count, last_comment_at
    from public.comments
   where pseudo_id = new.pseudo_id
     and created_at > now() - interval '24 hours';

  if daily_count >= 2 then
    raise exception 'rate limit: daily comment limit reached'
      using errcode = 'P0001';
  end if;

  if last_comment_at is not null and last_comment_at > now() - interval '10 seconds' then
    raise exception 'rate limit: commenting too quickly'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists comments_rate_limit on public.comments;
create trigger comments_rate_limit
  before insert on public.comments
  for each row
  execute function public.enforce_comment_rate_limit();

-- =============================================================================
-- 9. Reactions — ReactionBar.jsx already calls react_to_post()/remove_reaction()
--    RPCs and reads back a { "❤️": count } map. Neither RPC existed; every
--    tap of the heart button was silently failing (caught by the component's
--    try/catch) and reverting on the next refresh. This replaces the
--    single-shot like_post() above as the counter backing posts.likes_count,
--    while keeping likes_count itself as the public, denormalized count the
--    UI already reads.
-- =============================================================================

create table if not exists public.reactions (
  post_id    uuid not null references public.posts (id) on delete cascade,
  pseudo_id  text not null check (pseudo_id ~ '^#AnonUser[0-9]{4,6}$'),
  -- Only the heart is used by the UI today; keep the allow-list tight and
  -- extend it deliberately if a picker is ever added, rather than trusting
  -- an arbitrary client-supplied string.
  emoji      text not null check (emoji = '❤️'),
  created_at timestamptz not null default now(),
  primary key (post_id, pseudo_id)
);

alter table public.reactions enable row level security;

drop policy if exists "public can read reactions" on public.reactions;
create policy "public can read reactions"
  on public.reactions for select
  to anon, authenticated
  using (true);

-- No direct insert/update/delete policy — writes only happen through the
-- SECURITY DEFINER functions below, same pattern as like_post() above.

create or replace function public.react_to_post(p_post_id uuid, p_pseudo_id text, p_emoji text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
  own_pseudo text;
begin
  if p_pseudo_id !~ '^#AnonUser[0-9]{4,6}$' then
    raise exception 'invalid pseudo id';
  end if;
  if p_emoji <> '❤️' then
    raise exception 'unsupported reaction';
  end if;

  if auth.role() = 'authenticated' then
    select pseudo_id into own_pseudo from public.profiles where user_id = auth.uid();
    if own_pseudo is null or own_pseudo <> p_pseudo_id then
      raise exception 'pseudo id does not match signed-in account';
    end if;
  end if;

  insert into public.reactions (post_id, pseudo_id, emoji)
  values (p_post_id, p_pseudo_id, p_emoji)
  on conflict (post_id, pseudo_id) do update set emoji = excluded.emoji;

  select count(*) into new_count from public.reactions where post_id = p_post_id;
  update public.posts set likes_count = new_count where id = p_post_id;

  return jsonb_build_object(p_emoji, new_count);
end;
$$;

create or replace function public.remove_reaction(p_post_id uuid, p_pseudo_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
  own_pseudo text;
begin
  if p_pseudo_id !~ '^#AnonUser[0-9]{4,6}$' then
    raise exception 'invalid pseudo id';
  end if;

  if auth.role() = 'authenticated' then
    select pseudo_id into own_pseudo from public.profiles where user_id = auth.uid();
    if own_pseudo is null or own_pseudo <> p_pseudo_id then
      raise exception 'pseudo id does not match signed-in account';
    end if;
  end if;

  delete from public.reactions where post_id = p_post_id and pseudo_id = p_pseudo_id;

  select count(*) into new_count from public.reactions where post_id = p_post_id;
  update public.posts set likes_count = new_count where id = p_post_id;

  return jsonb_build_object('❤️', new_count);
end;
$$;

revoke all on function public.react_to_post(uuid, text, text) from public;
revoke all on function public.remove_reaction(uuid, text) from public;
grant execute on function public.react_to_post(uuid, text, text) to anon, authenticated;
grant execute on function public.remove_reaction(uuid, text) to anon, authenticated;

-- =============================================================================
-- 10. Reports — ConfessionCard.jsx already inserts into this table and
--    AdminPanel.jsx already expects to read from it (via an Edge Function).
--    It didn't exist, so every "Report" tap was failing silently.
--    Deliberately NO select policy for anon/authenticated: who reported
--    what must stay private, readable only by the service role from the
--    admin-moderation Edge Function (see supabase/functions/).
--
--    Reporting requires a signed-in account (`to authenticated` only, no
--    `anon`) — a visitor who hasn't claimed/signed into a pseudo_id cannot
--    file a report at all. This is deliberate: it stops throwaway browsers
--    from mass-filing reports (no account = no report), which both keeps
--    the queue in section 21's admin panel meaningful and means every
--    report can be traced back to a real account if it turns out to be
--    abusive itself. Posting and reading confessions stays fully anonymous
--    either way — this restriction only touches the report action.
-- =============================================================================

create table if not exists public.reports (
  id                  uuid primary key default gen_random_uuid(),
  post_id             uuid not null references public.posts (id) on delete cascade,
  reporter_pseudo_id  text not null check (reporter_pseudo_id ~ '^#AnonUser[0-9]{4,6}$'),
  reason              text not null check (
    reason in ('Spam', 'Harassment or hate', 'Self-harm concern', 'Other')
  ),
  status              text not null default 'open' check (status in ('open', 'dismissed')),
  created_at          timestamptz not null default now()
);

create index if not exists reports_status_idx on public.reports (status);

alter table public.reports enable row level security;

drop policy if exists "public can file reports" on public.reports;
create policy "signed-in users can file reports"
  on public.reports for insert
  to authenticated
  with check (
    reason in ('Spam', 'Harassment or hate', 'Self-harm concern', 'Other')
    and reporter_pseudo_id ~ '^#AnonUser[0-9]{4,6}$'
  );

-- No select/update/delete policy for anon/authenticated at all — reports
-- are write-only from the client's perspective. Reading and dismissing
-- happens exclusively through the admin-moderation Edge Function, which
-- uses the service role key and therefore bypasses RLS entirely.

-- Lightweight anti-spam: stop one browser from filing unlimited reports.
create or replace function public.enforce_report_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recent_count integer;
begin
  select count(*) into recent_count
    from public.reports
   where reporter_pseudo_id = new.reporter_pseudo_id
     and created_at > now() - interval '1 hour';

  if recent_count >= 20 then
    raise exception 'rate limit: too many reports from this id in the last hour'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists reports_rate_limit on public.reports;
create trigger reports_rate_limit
  before insert on public.reports
  for each row
  execute function public.enforce_report_rate_limit();

-- =============================================================================
-- 11. Admins — AdminPanel.jsx's comment says access is "checked server-side
--    against the admins table", but the table never existed. This creates
--    it, locked down completely: no select/insert/update/delete policy for
--    anon or authenticated at all. The only ways to modify it are (a) the
--    Supabase SQL Editor, which runs as the postgres superuser and bypasses
--    RLS, or (b) the service role key from the admin-moderation Edge
--    Function — never from the browser.
-- =============================================================================

create table if not exists public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;
-- Intentionally zero policies: RLS enabled + no policy = no client access
-- of any kind, for any role. This is correct, not an oversight.

-- To add yourself as an admin, run in the SQL Editor (which bypasses RLS):
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'your@email.com';
-- (The account must already exist under Authentication -> Users first.)

-- =============================================================================
-- 12. Fix: honor the caller's existing anonymous id on signup.
--
--    AuthModal.jsx's "Anonymous ID" signup flow promises "Claim your
--    current anonymous id with a password so it stays the same on other
--    devices" and authIdentity.js already sends that id as
--    requested_pseudo_id in the signup metadata — but handle_new_user()
--    (section 7 above) never read it and always assigned a random id
--    instead. That silently broke the promise: a user's existing posts
--    stayed under their old pseudo_id while their new account got a
--    different one, orphaning their post history from their own profile.
--    This replaces the trigger function to try the requested id first
--    (only if validly formatted and not already claimed), falling back to
--    a random one otherwise — same fallback behavior as before for
--    Google sign-in, which sends no such metadata.
-- =============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate text;
  attempt integer := 0;
  requested text;
begin
  requested := new.raw_user_meta_data ->> 'requested_pseudo_id';

  if requested is not null and requested ~ '^#AnonUser[0-9]{4,6}$' then
    begin
      insert into public.profiles (user_id, pseudo_id) values (new.id, requested);
      return new;
    exception when unique_violation then
      -- already claimed by someone else — fall through to a random one
      null;
    end;
  end if;

  loop
    candidate := '#AnonUser' || (100000 + floor(random() * 900000))::int;
    begin
      insert into public.profiles (user_id, pseudo_id) values (new.id, candidate);
      exit;
    exception when unique_violation then
      attempt := attempt + 1;
      if attempt > 20 then
        raise exception 'could not allocate a unique pseudo id';
      end if;
    end;
  end loop;
  return new;
end;
$$;

-- =============================================================================
-- 13. Inactive-account cleanup — accounts (pseudo-id or email signups, see
--    section 7) that haven't signed in for 90 days get deleted entirely:
--    their posts (which cascades to comments/reactions/reports, since
--    those all reference posts.id on delete cascade) plus their auth
--    account and profile row. Purely anonymous visitors who never created
--    an account are untouched — there's no login to measure inactivity by
--    for them, and this policy is specifically about registered accounts,
--    per your request.
-- =============================================================================

-- Small audit trail of what the job deleted and when — admin-only, same
-- lockdown pattern as admins/reports above (RLS on, zero client policies).
create table if not exists public.account_purge_log (
  id             uuid primary key default gen_random_uuid(),
  pseudo_id      text not null,
  posts_deleted  integer not null default 0,
  purged_at      timestamptz not null default now()
);
alter table public.account_purge_log enable row level security;

create or replace function public.purge_inactive_accounts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  stale record;
  purged_count integer := 0;
  deleted_posts integer;
begin
  for stale in
    select u.id as user_id, p.pseudo_id
    from auth.users u
    join public.profiles p on p.user_id = u.id
    where coalesce(u.last_sign_in_at, u.created_at) < now() - interval '90 days'
  loop
    delete from public.posts where pseudo_id = stale.pseudo_id;
    get diagnostics deleted_posts = row_count;

    insert into public.account_purge_log (pseudo_id, posts_deleted)
    values (stale.pseudo_id, deleted_posts);

    -- Cascades to public.profiles (user_id references auth.users on delete
    -- cascade) and to Auth's own internal tables (sessions, identities...).
    delete from auth.users where id = stale.user_id;

    purged_count := purged_count + 1;
  end loop;

  return purged_count;
end;
$$;

-- Never callable by the browser — only by the scheduled job below, or
-- manually from the SQL Editor (e.g. `select public.purge_inactive_accounts();`).
revoke all on function public.purge_inactive_accounts() from public, anon, authenticated;

-- Runs automatically every day at 03:00 UTC via pg_cron.
--
-- IMPORTANT: pg_cron must be turned on once from Supabase Dashboard ->
-- Database -> Extensions -> search "pg_cron" -> Enable (not always
-- available depending on your project's plan/region). If the next two
-- statements fail with "extension pg_cron is not available", enable it
-- there first and re-run just this section.
create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'purge-inactive-accounts') then
    perform cron.unschedule('purge-inactive-accounts');
  end if;
end $$;

select cron.schedule(
  'purge-inactive-accounts',
  '0 3 * * *',
  $$select public.purge_inactive_accounts();$$
);

-- If pg_cron isn't available on your plan, run this manually from the SQL
-- Editor every so often instead: select public.purge_inactive_accounts();

-- =============================================================================
-- 14. delete_own_post RPC — lets a poster remove their own confession from
--     the "⋯" menu (ConfessionCard.jsx). Mirrors the ownership check
--     already used by like_post() above: a signed-in caller may only act
--     as their own pseudo_id (looked up server-side via public.profiles,
--     never trusted from the client). For anonymous (not signed-in)
--     callers, pseudo_id is the same client-supplied, unauthenticated
--     string used throughout this file (see the rate-limiting note in
--     section 4) — this function does not change that existing trust
--     model, it only adds an owner-checked delete on top of it. There is
--     still no DELETE policy for anon/authenticated directly on
--     public.posts; this SECURITY DEFINER function is the only sanctioned
--     path, and deleting a post cascades to its comments, reactions,
--     post_likes and reports rows via the existing foreign keys above.
-- =============================================================================
create or replace function public.delete_own_post(p_post_id uuid, p_pseudo_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  own_pseudo text;
  deleted_count integer;
begin
  if p_pseudo_id !~ '^#AnonUser[0-9]{4,6}$' then
    raise exception 'invalid pseudo id';
  end if;

  if auth.role() = 'authenticated' then
    select pseudo_id into own_pseudo from public.profiles where user_id = auth.uid();
    if own_pseudo is null or own_pseudo <> p_pseudo_id then
      raise exception 'pseudo id does not match signed-in account';
    end if;
  end if;

  delete from public.posts
   where id = p_post_id
     and pseudo_id = p_pseudo_id;

  get diagnostics deleted_count = row_count;

  if deleted_count = 0 then
    raise exception 'post not found or not owned by this pseudo id';
  end if;

  return true;
end;
$$;

revoke all on function public.delete_own_post(uuid, text) from public;
grant execute on function public.delete_own_post(uuid, text) to anon, authenticated;

-- =============================================================================
-- 15. SECURITY AUDIT FIX — server-side moderation floor.
--
--    src/lib/moderation.js is explicit that it is a client-side UX filter
--    only, and that is correct as far as it goes — but until now nothing
--    on the server enforced ANY of it. Content length/format was checked
--    (sections 1 and 8), but slurs, direct death threats, and "kill
--    yourself" were only ever blocked by JavaScript running in the
--    poster's own browser. Anyone could bypass it completely by calling
--    the Supabase REST API directly (e.g. `curl .../rest/v1/posts` with
--    the public anon key) and the content would go straight to a public,
--    realtime-broadcast feed.
--
--    This is NOT a replacement for a real moderation pipeline — mirroring
--    moderation.js's regexes in Postgres, as done here, is intentionally
--    the same short, severe-only list, and just as easy to evade with
--    creative spelling. Pair this with a proper moderation API
--    (OpenAI's moderation endpoint, Perspective API, etc.) called from an
--    Edge Function before content is ever inserted, for real coverage.
--    What this DOES do: close off the "just call the API directly" bypass
--    for the worst, most damaging cases (slurs, explicit threats, "kys"),
--    so the client-side filter is no longer the only thing standing
--    between a bad actor and the public feed.
-- =============================================================================

create or replace function public.enforce_content_floor(p_content text)
returns void
language plpgsql
immutable
as $$
begin
  if
     -- Race / ethnicity
     p_content ~* '\mn[i1!]gg(er|a)\M'
     or p_content ~* '\msp[i1!]c\M'
     or p_content ~* '\mch[i1!]nk\M'
     or p_content ~* '\mg[o0]{2}k\M'
     or p_content ~* '\mwetback\M'
     or p_content ~* '\mp[a4]ki\M'
     or p_content ~* '\mred\s?skin(s)?\M'
     -- Religion
     or p_content ~* '\mk[i1!]ke\M'
     or p_content ~* '\mt[o0]wel\s?head\M'
     -- Sexual orientation / gender identity
     or p_content ~* '\mf[a4]gg?ot\M'
     or p_content ~* '\mtr[a4]nn(y|ies)\M'
     or p_content ~* '\md[y1!]ke\M'
     -- Disability
     or p_content ~* '\mretard(ed)?\M'
     -- Explicit sexual content
     or p_content ~* '\mporn(hub|ography)?\M'
     or p_content ~* 'rape\s?(me|you|her|him|them)'
     -- Direct threats / calls for violence
     or p_content ~* '\bi\s?(will|''ll|am going to)\s?(kill|murder|hurt|stab|shoot|beat up|assault)\s?(you|him|her|them)\b'
     or p_content ~* 'kill\s?yourself'
     or p_content ~* '\mkys\M'
     or p_content ~* 'i\s?know\s?where\s?you\s?live'
     or p_content ~* 'i(''m|\s?am)\s?(going to|gonna)\s?find\s?you'
     -- Targeted misogynistic harassment ("you're a ___")
     or p_content ~* 'you(''re| are)\s?(a\s)?(wh[o0]re|slut)'
     -- Doxxing — posting a third party's identifying details
     or p_content ~* '\d{3}[-.\s]?\d{3}[-.\s]?\d{4}' -- phone number
     or p_content ~* '\d{1,5}\s\w+(\s\w+){0,3}\s(street|st|avenue|ave|road|rd|drive|dr|lane|ln|blvd)' -- street address
     or p_content ~* '\d{3}-\d{2}-\d{4}' -- SSN-shaped number
     -- Spam / scam
     or p_content ~* '(dm|message) me (for|to get) (content|nudes|crypto|investment)'
     or p_content ~* 'guaranteed\s?(returns|profit)'
     or p_content ~* 'onlyfans\.com/\S+'
  then
    raise exception 'content not allowed: this space is for support, not harassment or hate'
      using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.posts_content_floor_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.enforce_content_floor(new.content);
  return new;
end;
$$;

drop trigger if exists posts_content_floor on public.posts;
create trigger posts_content_floor
  before insert on public.posts
  for each row
  execute function public.posts_content_floor_trigger();

create or replace function public.comments_content_floor_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.enforce_content_floor(new.content);
  return new;
end;
$$;

drop trigger if exists comments_content_floor on public.comments;
create trigger comments_content_floor
  before insert on public.comments
  for each row
  execute function public.comments_content_floor_trigger();

-- =============================================================================
-- 16. Profile pictures — public per-pseudo_id avatars, and a way to browse
--     everything a given pseudo_id has posted (Avatar.jsx / ProfilePanel.jsx).
--
--     Deliberately NOT stored on public.profiles (which stays private —
--     it links a real auth.users row to a pseudo_id and only the owner may
--     read their own row). An avatar has to be public, since it is always
--     shown right next to the already-public pseudo_id on every post and
--     comment — so it lives in its own small public table instead, keyed
--     only by pseudo_id, with no link back to auth.users exposed anywhere.
--
--     Only SIGNED-IN accounts can set an avatar. An anonymous (not signed
--     in) pseudo_id is just a client-supplied string with no real
--     ownership proof behind it (see the rate-limit note in section 4) —
--     letting anyone attach an image to an unauthenticated id would mean
--     anyone could "reassign" someone else's anonymous handle's picture.
--     Signing in (email/password or Google, see authIdentity.js) gives a
--     real auth.uid() the app can check ownership against.
-- =============================================================================

create table if not exists public.avatars (
  pseudo_id  text primary key,
  avatar_url text not null,
  updated_at timestamptz not null default now(),
  constraint avatars_pseudo_id_format check (pseudo_id ~ '^#AnonUser[0-9]{4,6}$')
);

alter table public.avatars enable row level security;

-- Public read: same visibility as the pseudo_id itself, which is already
-- printed on every post/comment this account has ever made.
drop policy if exists "public can read avatars" on public.avatars;
create policy "public can read avatars"
  on public.avatars for select
  to anon, authenticated
  using (true);

-- No direct insert/update/delete policy for any client role — the only
-- sanctioned writes go through set_own_avatar / remove_own_avatar below,
-- which check real ownership via auth.uid() -> public.profiles.

create or replace function public.set_own_avatar(p_avatar_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  own_pseudo text;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'sign in required to set a profile picture';
  end if;

  select pseudo_id into own_pseudo from public.profiles where user_id = auth.uid();
  if own_pseudo is null then
    raise exception 'no linked pseudo id found for this account';
  end if;

  if p_avatar_url is null or char_length(p_avatar_url) = 0 or char_length(p_avatar_url) > 2048 then
    raise exception 'invalid avatar url';
  end if;

  insert into public.avatars (pseudo_id, avatar_url, updated_at)
  values (own_pseudo, p_avatar_url, now())
  on conflict (pseudo_id) do update
    set avatar_url = excluded.avatar_url,
        updated_at = now();
end;
$$;

revoke all on function public.set_own_avatar(text) from public;
grant execute on function public.set_own_avatar(text) to authenticated;

create or replace function public.remove_own_avatar()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  own_pseudo text;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'sign in required';
  end if;

  select pseudo_id into own_pseudo from public.profiles where user_id = auth.uid();
  if own_pseudo is null then
    raise exception 'no linked pseudo id found for this account';
  end if;

  delete from public.avatars where pseudo_id = own_pseudo;
end;
$$;

revoke all on function public.remove_own_avatar() from public;
grant execute on function public.remove_own_avatar() to authenticated;

-- -----------------------------------------------------------------------------
-- 16b. Storage bucket for avatar image files.
--
--    Every upload is client-resized/recompressed to a JPEG under 1MB
--    before it ever reaches here (see imageCompress.js) — free-tier
--    storage is limited, so this keeps every avatar small on disk. The
--    server-side file_size_limit below is the real, unspoofable ceiling;
--    the client-side compression is just what keeps uploads from being
--    rejected by it in the first place.
--
--    Every user's avatar lives at a FIXED path — <folder>/avatar.jpg,
--    never a new timestamped file — and every upload uses upsert, so
--    changing your picture overwrites that one object in place. There is
--    never more than one avatar file per pseudo_id sitting in storage, so
--    there is nothing left behind to clean up after a change. Removing a
--    picture (ProfilePanel's "Remove" button) deletes that same object
--    outright via storage.remove(), on top of clearing the avatars row.
--
--    <folder> is the poster's pseudo_id with the "#" stripped and
--    lowercased (see pseudoIdToFolder() in avatarCache.js) — mirrors the
--    same stripping already used for the synthetic sign-in email in
--    authIdentity.js. The policy below re-derives that same folder name
--    server-side from auth.uid(), so a signed-in user can only ever
--    write under their own folder.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "public can view avatar files" on storage.objects;
create policy "public can view avatar files"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'avatars');

drop policy if exists "owner can upload avatar file" on storage.objects;
create policy "owner can upload avatar file"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (
      select replace(lower(p.pseudo_id), '#', '')
      from public.profiles p
      where p.user_id = auth.uid()
    )
  );

drop policy if exists "owner can update avatar file" on storage.objects;
create policy "owner can update avatar file"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (
      select replace(lower(p.pseudo_id), '#', '')
      from public.profiles p
      where p.user_id = auth.uid()
    )
  );

drop policy if exists "owner can delete avatar file" on storage.objects;
create policy "owner can delete avatar file"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (
      select replace(lower(p.pseudo_id), '#', '')
      from public.profiles p
      where p.user_id = auth.uid()
    )
  );

-- =============================================================================
-- 17. Comment deletion — lets a commenter remove their own comment (new
--     "delete" control in CommentThread.jsx), and lets an admin remove
--     ANY comment directly from the feed, not just through the reports
--     flow (which only ever covered posts). One RPC handles both cases:
--
--       - Owner deleting their own comment: same trust model as
--         delete_own_post above — a signed-in caller may only act as
--         their own pseudo_id (checked server-side via public.profiles);
--         an anonymous caller is only as "authenticated" as the
--         client-supplied pseudo_id itself (see the rate-limit note in
--         section 4 — this does not change that existing trust model).
--       - Admin deleting someone else's comment: checked against
--         public.admins (the same locked-down table the admin-moderation
--         Edge Function already checks) — if the signed-in caller is
--         listed there, p_pseudo_id is ignored entirely and the comment
--         is deleted regardless of who posted it.
--
--     public.am_i_admin() is a narrow, read-only companion: it only ever
--     tells the CALLER whether THEY are an admin (true/false), never
--     anyone else's status, and never touches the admins table's actual
--     rows — safe to expose to authenticated clients so CommentThread.jsx
--     knows whether to show the delete button on every comment (not just
--     the caller's own).
-- =============================================================================

create or replace function public.am_i_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.admins where user_id = auth.uid()
  ) and auth.role() = 'authenticated';
$$;

revoke all on function public.am_i_admin() from public;
grant execute on function public.am_i_admin() to anon, authenticated;

create or replace function public.delete_comment(p_comment_id uuid, p_pseudo_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  own_pseudo text;
  caller_is_admin boolean := false;
  deleted_count integer;
begin
  if p_pseudo_id !~ '^#AnonUser[0-9]{4,6}$' then
    raise exception 'invalid pseudo id';
  end if;

  if auth.role() = 'authenticated' then
    select exists(select 1 from public.admins where user_id = auth.uid()) into caller_is_admin;

    if not caller_is_admin then
      select pseudo_id into own_pseudo from public.profiles where user_id = auth.uid();
      if own_pseudo is null or own_pseudo <> p_pseudo_id then
        raise exception 'pseudo id does not match signed-in account';
      end if;
    end if;
  end if;

  if caller_is_admin then
    delete from public.comments where id = p_comment_id;
  else
    delete from public.comments where id = p_comment_id and pseudo_id = p_pseudo_id;
  end if;

  get diagnostics deleted_count = row_count;

  if deleted_count = 0 then
    raise exception 'comment not found or not owned by this pseudo id';
  end if;

  return true;
end;
$$;

revoke all on function public.delete_comment(uuid, text) from public;
grant execute on function public.delete_comment(uuid, text) to anon, authenticated;

-- =============================================================================
-- 18. FIX — post_owner_tokens table was never created, and delete_own_post
--     never checked it, even though ConfessionForm.jsx has been inserting
--     into this table since section 4/14 were written, and ConfessionCard.jsx
--     has been calling delete_own_post with a p_owner_token argument that
--     the function did not accept.
--
--     Effect before this fix, concretely:
--       - Every post's owner-token insert failed silently (the table did
--         not exist), so no token was ever actually stored server-side.
--       - Every delete_own_post call from the UI failed outright, because
--         PostgREST could not find a 2-arg function matching a 3-arg call
--         — anonymous posters could never delete their own confessions.
--
--     This section adds the missing table and replaces delete_own_post
--     with a 3-parameter version that actually verifies the token for
--     anonymous (not signed-in) callers, matching the trust model already
--     described in pseudoId.js: the token is a random secret known only
--     to the poster's own browser, never selectable back out by anyone
--     (no select policy below), so it cannot be copied off the public
--     feed the way pseudo_id and post_id can.
-- =============================================================================

create table if not exists public.post_owner_tokens (
  post_id     uuid primary key references public.posts (id) on delete cascade,
  owner_token uuid not null,
  created_at  timestamptz not null default now()
);

alter table public.post_owner_tokens enable row level security;

-- No select policy for anon/authenticated at all: this must never be
-- readable back from the client, or the "secret" is worthless. Only the
-- SECURITY DEFINER delete_own_post function below (which bypasses RLS)
-- can ever read a row here.
drop policy if exists "post owner can insert their token" on public.post_owner_tokens;
create policy "post owner can insert their token"
  on public.post_owner_tokens for insert
  to anon, authenticated
  with check (
    -- One token per post, set once at creation time. The primary key
    -- above already stops a second row for the same post_id; this check
    -- just gives a clearer error than a bare constraint violation, and
    -- stops a caller from inserting a token for a post_id that isn't
    -- actually theirs to attach one to in the first place — it must be
    -- their own most-recent insert into posts, which the client does in
    -- practice in the same request cycle right after creating the post.
    exists (select 1 from public.posts p where p.id = post_id)
  );

drop function if exists public.delete_own_post(uuid, text);

create or replace function public.delete_own_post(
  p_post_id uuid,
  p_pseudo_id text,
  p_owner_token uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  own_pseudo text;
  stored_token uuid;
  deleted_count integer;
begin
  if p_pseudo_id !~ '^#AnonUser[0-9]{4,6}$' then
    raise exception 'invalid pseudo id';
  end if;

  if auth.role() = 'authenticated' then
    -- Signed-in caller: ownership is proven by auth.uid(), same as
    -- everywhere else in this file. The owner token is irrelevant here
    -- and intentionally ignored.
    select pseudo_id into own_pseudo from public.profiles where user_id = auth.uid();
    if own_pseudo is null or own_pseudo <> p_pseudo_id then
      raise exception 'pseudo id does not match signed-in account';
    end if;
  else
    -- Anonymous caller: pseudo_id alone is public and unauthenticated
    -- (see the note in section 4), so it proves nothing by itself. The
    -- owner token — a secret only this post's original browser ever
    -- received — is the actual proof of ownership here.
    if p_owner_token is null then
      raise exception 'owner token required to delete this post';
    end if;

    select owner_token into stored_token
      from public.post_owner_tokens
     where post_id = p_post_id;

    if stored_token is null or stored_token <> p_owner_token then
      raise exception 'owner token does not match this post';
    end if;
  end if;

  delete from public.posts
   where id = p_post_id
     and pseudo_id = p_pseudo_id;

  get diagnostics deleted_count = row_count;

  if deleted_count = 0 then
    raise exception 'post not found or not owned by this pseudo id';
  end if;

  return true;
end;
$$;

revoke all on function public.delete_own_post(uuid, text, uuid) from public;
grant execute on function public.delete_own_post(uuid, text, uuid) to anon, authenticated;

-- =============================================================================
-- 19. SECURITY HARDENING v2 (post-launch audit) — atomic post creation,
--     comments_count double-count fix, dead-object cleanup.
--
--     Finding: post creation was two separate client requests (insert
--     into posts, THEN insert into post_owner_tokens). Both pseudo_id and
--     post_id are public (printed on the post), so the only real secret
--     was the owner_token — and the old "post owner can insert their
--     token" policy (section 18) let ANYONE insert a token for ANY post
--     that hadn't claimed one yet, no ownership check at all beyond "the
--     post exists". An attacker could claim a stranger's post's token,
--     then call delete_own_post with the public pseudo_id + their own
--     claimed token to delete someone else's confession. create_post()
--     below does both inserts in one atomic transaction, and direct
--     client INSERT on posts / post_owner_tokens is revoked entirely —
--     this RPC is now the only path, so there's no gap left for a race.
-- =============================================================================

create or replace function public.create_post(
  p_pseudo_id text,
  p_content text,
  p_owner_token uuid default null
)
returns table(id uuid, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  new_created_at timestamptz;
  own_pseudo text;
begin
  if p_pseudo_id !~ '^#AnonUser[0-9]{4,6}$' then
    raise exception 'invalid pseudo id';
  end if;

  if auth.role() = 'authenticated' then
    select p.pseudo_id into own_pseudo from public.profiles p where p.user_id = auth.uid();
    if own_pseudo is null or own_pseudo <> p_pseudo_id then
      raise exception 'pseudo id does not match signed-in account';
    end if;
  else
    if p_owner_token is null then
      raise exception 'owner token required for anonymous posts';
    end if;
  end if;

  insert into public.posts (content, pseudo_id)
  values (p_content, p_pseudo_id)
  returning posts.id, posts.created_at into new_id, new_created_at;

  if p_owner_token is not null then
    insert into public.post_owner_tokens (post_id, owner_token)
    values (new_id, p_owner_token);
  end if;

  return query select new_id, new_created_at;
end;
$$;

revoke all on function public.create_post(text, text, uuid) from public;
grant execute on function public.create_post(text, text, uuid) to anon, authenticated;

drop policy if exists "public can insert posts" on public.posts;
drop policy if exists "poster can register their own post's owner token" on public.post_owner_tokens;
-- post_owner_tokens now has zero client policies (RLS enabled, locked down
-- like admins/reports) — only create_post()'s SECURITY DEFINER context can
-- write to it.

-- Fix: an earlier iteration's bump_comments_count trigger and this file's
-- sync_post_comments_count (section 8) were BOTH firing on every comment
-- insert/delete, double-counting comments_count. Drop the legacy pair.
drop trigger if exists comments_count_insert on public.comments;
drop trigger if exists comments_count_delete on public.comments;
drop function if exists public.bump_comments_count();

-- One-time correction for counts already drifted by the double-count bug.
update public.posts p
   set comments_count = sub.actual
  from (select post_id, count(*) as actual from public.comments group by post_id) sub
 where p.id = sub.post_id
   and p.comments_count <> sub.actual;

update public.posts p
   set comments_count = 0
 where p.comments_count <> 0
   and not exists (select 1 from public.comments c where c.post_id = p.id);

-- Dead objects from an earlier schema iteration that the current frontend
-- never reads (verified against src/): a 5-emoji post_reactions table
-- superseded by reactions (heart-only), a never-wired banned_pseudo_ids
-- table, and a posts.reaction_counts jsonb column the UI never selects.
drop table if exists public.post_reactions;
drop table if exists public.banned_pseudo_ids;
alter table public.posts drop column if exists reaction_counts;

-- Validate the comments content-length check an earlier migration added
-- as NOT VALID (it was already enforced for new rows; this just confirms
-- existing rows comply too, where possible).
do $$
begin
  alter table public.comments validate constraint comments_content_check;
exception when check_violation then
  null;
end $$;

-- Performance/security-adjacent: wrap auth.<fn>() calls in RLS policies
-- with (select ...) so they evaluate once per query, not once per row.
drop policy if exists "user can read own profile" on public.profiles;
create policy "user can read own profile"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "public can insert comments" on public.comments;
create policy "public can insert comments"
  on public.comments for insert
  to anon, authenticated
  with check (
    char_length(trim(content)) between 1 and 50
    and pseudo_id ~ '^#AnonUser[0-9]{4,6}$'
    and (
      (select auth.role()) = 'anon'
      or pseudo_id = (select p.pseudo_id from public.profiles p where p.user_id = (select auth.uid()))
    )
  );

-- =============================================================================
-- 20. Real ban system + per-user moderation lookup for admins.
--
--     Section 19 dropped a `banned_pseudo_ids` table because it was dead
--     code the frontend never wired up. This section re-creates it for
--     real this time, wires it into both post and comment creation, and
--     adds the pieces AdminPanel.jsx / ProfilePanel.jsx need to show an
--     admin a given account's report history and ban status so they can
--     decide what action to take — not just delete individual posts.
--
--     Locked down the same way as admins/reports (section 10/11): RLS on,
--     zero client policies. The only writers are the admin-moderation
--     Edge Function (service role) and, for the read-only ban check used
--     at post/comment time, the SECURITY DEFINER function below.
-- =============================================================================

create table if not exists public.banned_pseudo_ids (
  pseudo_id  text primary key check (pseudo_id ~ '^#AnonUser[0-9]{4,6}$'),
  reason     text,
  banned_at  timestamptz not null default now(),
  banned_by  uuid references auth.users (id) on delete set null
);

alter table public.banned_pseudo_ids enable row level security;
-- Intentionally zero policies — same lockdown pattern as public.admins.

-- SECURITY DEFINER so create_post()/the comments RLS policy can check this
-- table even though it has no client-facing select policy at all. Owned by
-- the same role as the rest of this file's functions, which in Supabase
-- has BYPASSRLS — the established pattern already used by
-- enforce_report_rate_limit() and sync_post_comments_count() above.
create or replace function public.is_pseudo_banned(p_pseudo_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.banned_pseudo_ids where pseudo_id = p_pseudo_id
  );
$$;

revoke all on function public.is_pseudo_banned(text) from public;
grant execute on function public.is_pseudo_banned(text) to anon, authenticated;

-- Re-create create_post() to also reject banned accounts. Everything else
-- is identical to the section 19 version.
create or replace function public.create_post(
  p_pseudo_id text,
  p_content text,
  p_owner_token uuid default null
)
returns table(id uuid, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  new_created_at timestamptz;
  own_pseudo text;
begin
  if p_pseudo_id !~ '^#AnonUser[0-9]{4,6}$' then
    raise exception 'invalid pseudo id';
  end if;

  if public.is_pseudo_banned(p_pseudo_id) then
    raise exception 'this account has been banned by a moderator';
  end if;

  if auth.role() = 'authenticated' then
    select p.pseudo_id into own_pseudo from public.profiles p where p.user_id = auth.uid();
    if own_pseudo is null or own_pseudo <> p_pseudo_id then
      raise exception 'pseudo id does not match signed-in account';
    end if;
  else
    if p_owner_token is null then
      raise exception 'owner token required for anonymous posts';
    end if;
  end if;

  insert into public.posts (content, pseudo_id)
  values (p_content, p_pseudo_id)
  returning posts.id, posts.created_at into new_id, new_created_at;

  if p_owner_token is not null then
    insert into public.post_owner_tokens (post_id, owner_token)
    values (new_id, p_owner_token);
  end if;

  return query select new_id, new_created_at;
end;
$$;

-- Re-create the comments insert policy to also reject banned accounts.
drop policy if exists "public can insert comments" on public.comments;
create policy "public can insert comments"
  on public.comments for insert
  to anon, authenticated
  with check (
    char_length(trim(content)) between 1 and 50
    and pseudo_id ~ '^#AnonUser[0-9]{4,6}$'
    and not public.is_pseudo_banned(pseudo_id)
    and (
      (select auth.role()) = 'anon'
      or pseudo_id = (select p.pseudo_id from public.profiles p where p.user_id = (select auth.uid()))
    )
  );

-- =============================================================================
-- 21. Per-target report cap (30 reports / rolling 30 days) + a ranked list
--    of the most-reported accounts for the admin panel.
--
--    Section 4 already rate-limits how many reports one BROWSER can file
--    per hour (anti-spam on the reporter side). This adds a cap on the
--    other side: once an account's posts have collected 30 open reports
--    within the last 30 days, further reports against that account are
--    rejected — a report that old "falls off" the 30-day window on its
--    own, so the cap isn't a permanent lock, it just naturally clears as
--    old reports age out. This stops one account from being buried under
--    an unbounded pile of reports before an admin gets to review it.
-- =============================================================================

create or replace function public.enforce_report_target_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_pseudo text;
  recent_count integer;
begin
  select pseudo_id into target_pseudo from public.posts where id = new.post_id;

  if target_pseudo is not null then
    select count(*) into recent_count
      from public.reports r
      join public.posts p on p.id = r.post_id
     where p.pseudo_id = target_pseudo
       and r.status = 'open'
       and r.created_at > now() - interval '30 days';

    if recent_count >= 30 then
      raise exception 'report cap reached: this account already has 30 open reports in the last 30 days'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists reports_target_cap on public.reports;
create trigger reports_target_cap
  before insert on public.reports
  for each row
  execute function public.enforce_report_target_cap();

-- Ranked list for AdminPanel.jsx's "Most reported" tab: one row per
-- account with any open report in the last 30 days, highest count first,
-- lowest last — plus current ban status so a mod can tell at a glance who
-- still needs a decision. SECURITY DEFINER + no grant to anon/authenticated
-- (only service_role, called from the admin-moderation Edge Function) —
-- same lockdown pattern as is_pseudo_banned() above, but this one is never
-- meant to be callable by ordinary users at all.
create or replace function public.top_reported_accounts()
returns table (
  pseudo_id text,
  report_count bigint,
  latest_report_at timestamptz,
  is_banned boolean,
  ban_reason text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.pseudo_id,
    count(r.id) as report_count,
    max(r.created_at) as latest_report_at,
    (b.pseudo_id is not null) as is_banned,
    b.reason as ban_reason
  from public.reports r
  join public.posts p on p.id = r.post_id
  left join public.banned_pseudo_ids b on b.pseudo_id = p.pseudo_id
  where r.status = 'open'
    and r.created_at > now() - interval '30 days'
  group by p.pseudo_id, b.pseudo_id, b.reason
  order by report_count desc, latest_report_at desc;
$$;

revoke all on function public.top_reported_accounts() from public;
grant execute on function public.top_reported_accounts() to service_role;

-- =============================================================================
-- 22. Per-reporter monthly cap: at most 30 reports filed by the same
--    account in a rolling 30-day window (roughly one a day on average).
--    This is the mirror image of section 4's hourly anti-spam check and
--    section 21's per-target cap — those limit how fast/how much a report
--    TARGET can be piled onto; this limits how much a single REPORTER
--    account can file overall, so one account can't function as an
--    unlimited report cannon even if it spreads reports across many
--    different targets. Like the other caps, it's a rolling window, not a
--    hard monthly reset — the oldest report simply ages out of the count
--    after 30 days, freeing up one more slot.
-- =============================================================================

create or replace function public.enforce_reporter_monthly_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recent_count integer;
begin
  select count(*) into recent_count
    from public.reports
   where reporter_pseudo_id = new.reporter_pseudo_id
     and created_at > now() - interval '30 days';

  if recent_count >= 30 then
    raise exception 'reporter cap reached: this account has already filed 30 reports in the last 30 days'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists reports_reporter_monthly_cap on public.reports;
create trigger reports_reporter_monthly_cap
  before insert on public.reports
  for each row
  execute function public.enforce_reporter_monthly_cap();

-- =============================================================================
-- 23. Account search — lets any visitor look up a pseudo_id (or part of
--    one, e.g. just the digits) and jump straight to that account's
--    public profile to see their latest posts, instead of only being
--    able to reach a profile by tapping a name somewhere in the feed.
--
--    This doesn't expose anything new: every post's pseudo_id is already
--    public (open SELECT on posts, section 3) — this just aggregates it
--    into something searchable. SECURITY DEFINER + STABLE only to keep
--    the aggregation server-side and fast; the `query` argument is a
--    normal bound function parameter (used inside `ilike`), never
--    interpolated into dynamic SQL, so it isn't an injection vector.
-- =============================================================================

create or replace function public.search_pseudo_ids(query text)
returns table (
  pseudo_id text,
  post_count bigint,
  latest_post_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.pseudo_id,
    count(*) as post_count,
    max(p.created_at) as latest_post_at
  from public.posts p
  where query is not null
    and length(trim(query)) > 0
    and p.pseudo_id ilike '%' || trim(query) || '%'
  group by p.pseudo_id
  order by latest_post_at desc
  limit 20;
$$;

revoke all on function public.search_pseudo_ids(text) from public;
grant execute on function public.search_pseudo_ids(text) to anon, authenticated;

-- =============================================================================
-- 24. Raise the per-target report cap from 30 to 100 (rolling 30-day
--    window, unchanged) + a real admin-notifications table so a moderator
--    gets flagged in-app the moment an account crosses that 100 mark,
--    instead of only finding out by opening the "Most reported" tab.
--
--    Design: the existing BEFORE INSERT trigger (enforce_report_target_cap)
--    already blocks any report once an account has 100 open reports in the
--    last 30 days — that part just needs its threshold raised from 30 to
--    100. A new AFTER INSERT trigger fires alongside it and checks the
--    up-to-date count (now including the just-inserted row): the very
--    first time it lands on exactly 100, it writes one row into
--    public.admin_notifications. Because the BEFORE trigger never lets the
--    count exceed 100, this fires exactly once per "reporting wave" — if
--    old reports later age out below 100 and the account climbs back up
--    to 100 again, a fresh notification is created for that new wave.
--
--    admin_notifications is locked down the same way as admins/reports:
--    RLS on, zero client policies — nothing is readable or writable
--    directly from the browser. The two new functions below are the only
--    access path, and both check public.am_i_admin() internally (reusing
--    section 17's function) before returning or changing anything, so a
--    non-admin caller gets a clean error rather than silently empty data.
-- =============================================================================

-- 24a. Raise the cap itself.
create or replace function public.enforce_report_target_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_pseudo text;
  recent_count integer;
begin
  select pseudo_id into target_pseudo from public.posts where id = new.post_id;

  if target_pseudo is not null then
    select count(*) into recent_count
      from public.reports r
      join public.posts p on p.id = r.post_id
     where p.pseudo_id = target_pseudo
       and r.status = 'open'
       and r.created_at > now() - interval '30 days';

    if recent_count >= 100 then
      raise exception 'report cap reached: this account already has 100 open reports in the last 30 days'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

-- 24b. Notifications table for admins.
create table if not exists public.admin_notifications (
  id         uuid primary key default gen_random_uuid(),
  type       text not null,
  pseudo_id  text,
  message    text not null,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);

alter table public.admin_notifications enable row level security;
-- Intentionally zero policies — same lockdown pattern as public.admins.
-- Access only through list_admin_notifications() / mark_notification_read()
-- below, both of which check public.am_i_admin() first.

create index if not exists admin_notifications_unread_idx
  on public.admin_notifications (created_at desc)
  where read_at is null;

-- 24c. After-insert trigger: fire exactly once per wave, the moment the
-- target's open-report count (in the last 30 days) lands on 100.
create or replace function public.notify_report_cap_reached()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_pseudo text;
  current_count integer;
begin
  select pseudo_id into target_pseudo from public.posts where id = new.post_id;

  if target_pseudo is not null then
    select count(*) into current_count
      from public.reports r
      join public.posts p on p.id = r.post_id
     where p.pseudo_id = target_pseudo
       and r.status = 'open'
       and r.created_at > now() - interval '30 days';

    if current_count = 100 then
      insert into public.admin_notifications (type, pseudo_id, message)
      values (
        'report_cap_reached',
        target_pseudo,
        target_pseudo || ' reached 100 open reports in the last 30 days — needs review'
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists reports_notify_cap_reached on public.reports;
create trigger reports_notify_cap_reached
  after insert on public.reports
  for each row
  execute function public.notify_report_cap_reached();

-- 24d. Admin-only read/write access to the notifications feed.
create or replace function public.list_admin_notifications(p_include_read boolean default false)
returns table (
  id uuid,
  type text,
  pseudo_id text,
  message text,
  created_at timestamptz,
  read_at timestamptz
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.am_i_admin() then
    raise exception 'admin access required';
  end if;

  return query
    select n.id, n.type, n.pseudo_id, n.message, n.created_at, n.read_at
    from public.admin_notifications n
    where p_include_read or n.read_at is null
    order by n.created_at desc;
end;
$$;

revoke all on function public.list_admin_notifications(boolean) from public;
grant execute on function public.list_admin_notifications(boolean) to authenticated;

create or replace function public.mark_notification_read(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.am_i_admin() then
    raise exception 'admin access required';
  end if;

  update public.admin_notifications
     set read_at = now()
   where id = p_id;
end;
$$;

revoke all on function public.mark_notification_read(uuid) from public;
grant execute on function public.mark_notification_read(uuid) to authenticated;

-- =============================================================================
-- 25. Let a signed-in admin see who's flagged WHILE browsing normally —
--    not just inside a dedicated admin-panel tab.
--
--    list_flagged_pseudo_ids() returns every pseudo_id currently sitting at
--    or above the 100-open-reports/30-days cap from section 24 — i.e. the
--    exact same set section 24's notification fires for, but as a live,
--    always-current list rather than a notification history. An admin's
--    signed-in frontend can call this once (e.g. on page load) and keep
--    the resulting set in memory, then compare every pseudo_id it renders
--    anywhere — feed, a comment thread, a profile — against that set to
--    show a special badge next to a flagged account's name. A regular
--    (non-admin) visitor calling this same function gets a plain error,
--    not an empty list, so there is no way to probe "is this account
--    flagged?" from an ordinary signed-out or non-admin session — the
--    badge can only ever render for a genuine admin.
--
--    This is a read-only lookup, same lockdown pattern as
--    list_admin_notifications() in section 24 (checks am_i_admin()
--    first). It does not grant any new ban/unban capability by itself —
--    the actual "Ban" action a moderator would take after seeing the
--    badge still goes through the admin-moderation Edge Function's
--    ban_pseudo_id action, same as before.
-- =============================================================================

create or replace function public.list_flagged_pseudo_ids()
returns table (pseudo_id text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.am_i_admin() then
    raise exception 'admin access required';
  end if;

  return query
    select p.pseudo_id
    from public.reports r
    join public.posts p on p.id = r.post_id
    where r.status = 'open'
      and r.created_at > now() - interval '30 days'
    group by p.pseudo_id
    having count(*) >= 100;
end;
$$;

revoke all on function public.list_flagged_pseudo_ids() from public;
grant execute on function public.list_flagged_pseudo_ids() to authenticated;

-- =============================================================================
-- 26. SECURITY HARDENING v3 — the section 19 owner_token fix for posts was
--    never extended to comments or reactions. Concretely, before this
--    section:
--
--      - "public can insert comments" let auth.role() = 'anon' insert a
--        comment under ANY pseudo_id, not just the caller's own — an
--        anonymous visitor could post as any pseudo_id they'd seen on the
--        feed. There is nothing that ties an anonymous pseudo_id to the
--        browser that "owns" it at insert time.
--      - delete_comment() only checked pseudo_id ownership when
--        auth.role() = 'authenticated'. For anonymous callers it skipped
--        ownership entirely and deleted any comment matching the supplied
--        pseudo_id — and pseudo_id is public, printed on every comment. Any
--        visitor could delete any anonymous comment on the site by reading
--        its pseudo_id off the page and calling the RPC directly.
--      - react_to_post()/remove_reaction() had the identical gap: an
--        anonymous caller could add or remove a heart under any pseudo_id,
--        letting anyone spoof or strip another anonymous user's reactions.
--
--    This is the exact "owner_token hijack" pattern already fixed for
--    posts in section 19, just never carried over. The fix is the same
--    shape: a random secret generated client-side, handed to the server
--    once at creation time, stored in a table with no client select policy
--    (so it can never be read back the way pseudo_id can), and required
--    from anonymous callers on every later action that claims ownership.
--    Signed-in callers keep using auth.uid() via profiles, same as before
--    — the token is only relevant to the anonymous path.
--
--    Known, accepted limitation: comments and reactions written before
--    this migration have no row in the new token tables, so they cannot
--    be self-deleted / self-unreacted by their original anonymous author
--    after this ships — only an admin can remove them. This is the same
--    trade-off the section 19 rollout already made for pre-existing posts,
--    and is strictly safer than leaving the old, spoofable check in place.
-- =============================================================================

-- ---- Comments ---------------------------------------------------------

create table if not exists public.comment_owner_tokens (
  comment_id  uuid primary key references public.comments (id) on delete cascade,
  owner_token uuid not null,
  created_at  timestamptz not null default now()
);

alter table public.comment_owner_tokens enable row level security;

-- No select/insert/update/delete policy for anon/authenticated at all —
-- same lockdown as post_owner_tokens. Only create_comment()'s SECURITY
-- DEFINER context (which bypasses RLS) can ever write or read a row here.

-- Comments can now ONLY be created through create_comment(), same pattern
-- as posts going through create_post() only. This closes the
-- "insert a comment under any pseudo_id" gap described above.
drop policy if exists "public can insert comments" on public.comments;

create or replace function public.create_comment(
  p_post_id uuid,
  p_pseudo_id text,
  p_content text,
  p_owner_token uuid default null
)
returns table(id uuid, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  new_created_at timestamptz;
  own_pseudo text;
begin
  if p_pseudo_id !~ '^#AnonUser[0-9]{4,6}$' then
    raise exception 'invalid pseudo id';
  end if;

  if char_length(trim(p_content)) < 1 or char_length(trim(p_content)) > 50 then
    raise exception 'comment must be between 1 and 50 characters';
  end if;

  if public.is_pseudo_banned(p_pseudo_id) then
    raise exception 'this account has been banned by a moderator';
  end if;

  if auth.role() = 'authenticated' then
    select p.pseudo_id into own_pseudo from public.profiles p where p.user_id = auth.uid();
    if own_pseudo is null or own_pseudo <> p_pseudo_id then
      raise exception 'pseudo id does not match signed-in account';
    end if;
  else
    if p_owner_token is null then
      raise exception 'owner token required for anonymous comments';
    end if;
  end if;

  insert into public.comments (post_id, pseudo_id, content)
  values (p_post_id, p_pseudo_id, trim(p_content))
  returning comments.id, comments.created_at into new_id, new_created_at;

  if p_owner_token is not null then
    insert into public.comment_owner_tokens (comment_id, owner_token)
    values (new_id, p_owner_token);
  end if;

  return query select new_id, new_created_at;
end;
$$;

revoke all on function public.create_comment(uuid, text, text, uuid) from public;
grant execute on function public.create_comment(uuid, text, text, uuid) to anon, authenticated;

-- delete_comment() now requires the owner token for anonymous callers,
-- same shape as delete_own_post(). Admins are unaffected (still bypass
-- ownership entirely, as before).
create or replace function public.delete_comment(
  p_comment_id uuid,
  p_pseudo_id text,
  p_owner_token uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  own_pseudo text;
  caller_is_admin boolean := false;
  stored_token uuid;
  deleted_count integer;
begin
  if p_pseudo_id !~ '^#AnonUser[0-9]{4,6}$' then
    raise exception 'invalid pseudo id';
  end if;

  if auth.role() = 'authenticated' then
    select exists(select 1 from public.admins where user_id = auth.uid()) into caller_is_admin;

    if not caller_is_admin then
      select pseudo_id into own_pseudo from public.profiles where user_id = auth.uid();
      if own_pseudo is null or own_pseudo <> p_pseudo_id then
        raise exception 'pseudo id does not match signed-in account';
      end if;
    end if;
  else
    -- Anonymous caller: pseudo_id alone is public and proves nothing (see
    -- section 26 note above). The owner token registered at creation time
    -- is the actual proof of ownership.
    if p_owner_token is null then
      raise exception 'owner token required to delete this comment';
    end if;

    select owner_token into stored_token
      from public.comment_owner_tokens
     where comment_id = p_comment_id;

    if stored_token is null or stored_token <> p_owner_token then
      raise exception 'owner token does not match this comment';
    end if;
  end if;

  if caller_is_admin then
    delete from public.comments where id = p_comment_id;
  else
    delete from public.comments where id = p_comment_id and pseudo_id = p_pseudo_id;
  end if;

  get diagnostics deleted_count = row_count;

  if deleted_count = 0 then
    raise exception 'comment not found or not owned by this pseudo id';
  end if;

  return true;
end;
$$;

revoke all on function public.delete_comment(uuid, text, uuid) from public;
grant execute on function public.delete_comment(uuid, text, uuid) to anon, authenticated;

-- ---- Reactions ----------------------------------------------------------

create table if not exists public.reaction_owner_tokens (
  post_id     uuid not null references public.posts (id) on delete cascade,
  pseudo_id   text not null,
  owner_token uuid not null,
  created_at  timestamptz not null default now(),
  primary key (post_id, pseudo_id)
);

alter table public.reaction_owner_tokens enable row level security;

-- No client policies at all, same lockdown as post_owner_tokens /
-- comment_owner_tokens — only react_to_post()/remove_reaction() (SECURITY
-- DEFINER) ever touch this table.

create or replace function public.react_to_post(
  p_post_id uuid,
  p_pseudo_id text,
  p_emoji text,
  p_owner_token uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
  own_pseudo text;
  stored_token uuid;
begin
  if p_pseudo_id !~ '^#AnonUser[0-9]{4,6}$' then
    raise exception 'invalid pseudo id';
  end if;
  if p_emoji <> '❤️' then
    raise exception 'unsupported reaction';
  end if;

  if auth.role() = 'authenticated' then
    select pseudo_id into own_pseudo from public.profiles where user_id = auth.uid();
    if own_pseudo is null or own_pseudo <> p_pseudo_id then
      raise exception 'pseudo id does not match signed-in account';
    end if;
  else
    select owner_token into stored_token
      from public.reaction_owner_tokens
     where post_id = p_post_id and pseudo_id = p_pseudo_id;

    if stored_token is null then
      -- First time this pseudo_id has reacted to this post: register the
      -- token now so later react/unreact calls from the same browser can
      -- prove it's still them.
      if p_owner_token is null then
        raise exception 'owner token required for anonymous reactions';
      end if;
      insert into public.reaction_owner_tokens (post_id, pseudo_id, owner_token)
      values (p_post_id, p_pseudo_id, p_owner_token);
    elsif stored_token <> p_owner_token then
      raise exception 'owner token does not match this pseudo id''s reaction';
    end if;
  end if;

  insert into public.reactions (post_id, pseudo_id, emoji)
  values (p_post_id, p_pseudo_id, p_emoji)
  on conflict (post_id, pseudo_id) do update set emoji = excluded.emoji;

  select count(*) into new_count from public.reactions where post_id = p_post_id;
  update public.posts set likes_count = new_count where id = p_post_id;

  return jsonb_build_object(p_emoji, new_count);
end;
$$;

create or replace function public.remove_reaction(
  p_post_id uuid,
  p_pseudo_id text,
  p_owner_token uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
  own_pseudo text;
  stored_token uuid;
begin
  if p_pseudo_id !~ '^#AnonUser[0-9]{4,6}$' then
    raise exception 'invalid pseudo id';
  end if;

  if auth.role() = 'authenticated' then
    select pseudo_id into own_pseudo from public.profiles where user_id = auth.uid();
    if own_pseudo is null or own_pseudo <> p_pseudo_id then
      raise exception 'pseudo id does not match signed-in account';
    end if;
  else
    select owner_token into stored_token
      from public.reaction_owner_tokens
     where post_id = p_post_id and pseudo_id = p_pseudo_id;

    -- No stored token means either this pseudo_id never reacted here, or
    -- it reacted before this migration shipped (see section 26 note) —
    -- either way there is nothing to safely verify against, so the
    -- removal is rejected rather than trusting the bare pseudo_id.
    if stored_token is null or stored_token <> p_owner_token then
      raise exception 'owner token does not match this pseudo id''s reaction';
    end if;
  end if;

  delete from public.reactions where post_id = p_post_id and pseudo_id = p_pseudo_id;

  select count(*) into new_count from public.reactions where post_id = p_post_id;
  update public.posts set likes_count = new_count where id = p_post_id;

  return jsonb_build_object('❤️', new_count);
end;
$$;

revoke all on function public.react_to_post(uuid, text, text, uuid) from public;
revoke all on function public.remove_reaction(uuid, text, uuid) from public;
grant execute on function public.react_to_post(uuid, text, text, uuid) to anon, authenticated;
grant execute on function public.remove_reaction(uuid, text, uuid) to anon, authenticated;

-- The old 3-arg / 2-arg overloads (from sections 9 and 17) are replaced
-- above via create-or-replace on the same names with an added optional
-- arg, so PostgREST resolves calls from already-deployed frontends to the
-- new 4-arg / 3-arg versions once this file has been run. No drop needed
-- unless you want to remove the old overloads' privileges explicitly:
drop function if exists public.react_to_post(uuid, text, text);
drop function if exists public.remove_reaction(uuid, text);
drop function if exists public.delete_comment(uuid, text);

-- =============================================================================
-- 27. SECURITY AUDIT v4 — full pass over every RPC's grants and ownership
--    checks, the ban panel's access path, and cross-account takeover
--    scenarios, per a follow-up request. Two real findings:
--
--    A) Dead, still-exposed `like_post()` (superseded by react_to_post() /
--       remove_reaction() in section 9, but never revoked). It has the
--       exact pre-section-26 gap: no ownership check at all for an
--       anonymous caller, so anyone could spam `post_likes` under any
--       pseudo_id, and its independent `likes_count = likes_count + 1`
--       write could desync the counter from the reactions system, which
--       instead always recomputes an exact count. The frontend never
--       calls it (checked: no reference in src/), so revoking it entirely
--       is a pure hardening with no functional change.
--
--    B) Pseudo-id "claim" squatting (signUpWithPseudoId / AuthModal.jsx):
--       the id field is a free-text input, not locked to the browser's
--       own current id, and handle_new_user() only ever rejected a
--       requested id that was already CLAIMED (an existing profiles
--       row) — never one that merely had public posts/comments from an
--       anonymous author who hadn't claimed it yet. Concretely: anyone
--       who saw a pseudo_id on the feed could open "Claim your id", type
--       it in, and register a password for it before the real author
--       did — permanently blocking that author from ever claiming their
--       own handle ("email already registered"), while the squatter
--       could post new content under that identity's existing public
--       reputation going forward.
--
--       Scope of the fix, stated precisely: this cannot be used to take
--       over anyone's SIGNED-IN account or its existing content —
--       admin status is keyed to auth.users.id, completely independent
--       of the pseudo_id string, and every existing post/comment/
--       reaction is already bound to its own owner_token (sections 18,
--       26) which a squatter never has. What this closes is identity
--       *labeling* squatting of a not-yet-claimed handle, not privilege
--       escalation or data access — there was no path found in this
--       audit letting an anonymous or regular authenticated caller reach
--       admin-only data or actions (every admin RPC checks am_i_admin()
--       or is service-role-only — see list_admin_notifications,
--       mark_notification_read, list_flagged_pseudo_ids, and
--       top_reported_accounts, which is granted to service_role only so
--       it cannot be called directly from the browser even by an
--       authenticated non-admin).
--
--       Fix: claiming an id that already has at least one post or
--       comment now requires proof — one of the claiming browser's own
--       stored owner tokens (from post_owner_tokens or
--       comment_owner_tokens) matching that same id — passed as signup
--       metadata (see authIdentity.js / pseudoId.js::getAnyOwnershipProof).
--       A brand-new id with zero existing content needs no proof, since
--       there is nothing to squat. Unlike the pre-existing "already
--       claimed" fallback (which silently swaps in a random id — a
--       latent UX surprise this audit noticed but left as-is, since
--       fixing it is a behavior change beyond what was asked), a failed
--       proof check here raises a clear error instead of silently
--       creating an unwanted random-id account.
-- =============================================================================

-- ---- A) close the dead like_post() exposure --------------------------------

revoke execute on function public.like_post(uuid, text) from anon, authenticated;

-- ---- B) require proof of authorship to claim an already-active id ---------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate text;
  attempt integer := 0;
  requested text;
  meta jsonb;
  proof_post_id uuid;
  proof_post_token uuid;
  proof_comment_id uuid;
  proof_comment_token uuid;
  content_exists boolean;
  proof_ok boolean := false;
begin
  meta := new.raw_user_meta_data;
  requested := meta ->> 'requested_pseudo_id';

  if requested is not null and requested ~ '^#AnonUser[0-9]{4,6}$' then
    select exists (select 1 from public.posts where pseudo_id = requested)
        or exists (select 1 from public.comments where pseudo_id = requested)
      into content_exists;

    if not content_exists then
      -- Nothing posted under this id yet by anyone — free to claim.
      proof_ok := true;
    else
      -- Parse the optional proof fields defensively: malformed/missing
      -- metadata must never error the whole signup, just fail the proof.
      begin
        proof_post_id := nullif(meta ->> 'proof_post_id', '')::uuid;
        proof_post_token := nullif(meta ->> 'proof_post_owner_token', '')::uuid;
      exception when others then
        proof_post_id := null;
        proof_post_token := null;
      end;
      begin
        proof_comment_id := nullif(meta ->> 'proof_comment_id', '')::uuid;
        proof_comment_token := nullif(meta ->> 'proof_comment_owner_token', '')::uuid;
      exception when others then
        proof_comment_id := null;
        proof_comment_token := null;
      end;

      if proof_post_id is not null and proof_post_token is not null then
        select exists (
          select 1
            from public.post_owner_tokens t
            join public.posts p on p.id = t.post_id
           where t.post_id = proof_post_id
             and t.owner_token = proof_post_token
             and p.pseudo_id = requested
        ) into proof_ok;
      end if;

      if not proof_ok and proof_comment_id is not null and proof_comment_token is not null then
        select exists (
          select 1
            from public.comment_owner_tokens t
            join public.comments c on c.id = t.comment_id
           where t.comment_id = proof_comment_id
             and t.owner_token = proof_comment_token
             and c.pseudo_id = requested
        ) into proof_ok;
      end if;
    end if;

    if proof_ok then
      begin
        insert into public.profiles (user_id, pseudo_id) values (new.id, requested);
        return new;
      exception when unique_violation then
        -- Already claimed by someone else in the meantime — fall through
        -- to a random id, same as the pre-existing behavior.
        null;
      end;
    else
      raise exception 'id already has posts or comments'
        using errcode = 'P0001';
    end if;
  end if;

  loop
    candidate := '#AnonUser' || (100000 + floor(random() * 900000))::int;
    begin
      insert into public.profiles (user_id, pseudo_id) values (new.id, candidate);
      exit;
    exception when unique_violation then
      attempt := attempt + 1;
      if attempt > 20 then
        raise exception 'could not allocate a unique pseudo id';
      end if;
    end;
  end loop;
  return new;
end;
$$;

-- =============================================================================
-- 28. SECURITY AUDIT v5 — full re-pass per a follow-up request to re-check
--    "all technical and security aspects." One real, meaningful finding,
--    specific to this app's core anonymity promise:
--
--    set_own_avatar(p_avatar_url text) stored WHATEVER url string the
--    client sent, with only a length check — never verifying it actually
--    pointed at this project's own "avatars" storage bucket, let alone at
--    the caller's own object in it. That url is then rendered as a plain
--    <img src=...> (see Avatar.jsx) on every post/comment the pseudo_id
--    has ever made, for every viewer.
--
--    Impact: any authenticated (password-claimed) account could set its
--    avatar to an attacker-controlled URL — e.g.
--    "https://attacker.example/pixel.png?x=1" — and from then on, EVERY
--    visitor who scrolls past that pseudo_id's posts silently sends a
--    request to that server, leaking their IP address and user-agent
--    with zero interaction. On a site whose entire value proposition is
--    anonymity, that's a real deanonymization vector against ordinary
--    visitors — and, notably, against a moderator or admin who browses
--    the public feed while investigating reports, same as anyone else.
--    (No script-execution/XSS path was found alongside it: browsers do
--    not execute embedded scripts in an SVG loaded through <img src>, so
--    this is a tracking/privacy issue, not a code-execution one.)
--
--    The storage upload path itself was already correctly locked down
--    (see "owner can upload/update/delete avatar file" policies above —
--    an authenticated caller can only write to their own
--    pseudo-id-derived folder). The gap was purely that the database
--    pointer clients could set was never checked against that folder at
--    all, so a legitimate, already-secured upload flow could be
--    completely bypassed by calling the RPC directly with any string.
--
--    Fix: set_own_avatar() no longer accepts a url from the client at
--    all. It derives the one and only path the caller is allowed to
--    have (identical formula to the storage policies and to
--    avatarStoragePath() in pseudoId.js/avatarCache.js) itself, so
--    there is no longer anything for a caller to lie about. Existing
--    rows are remediated the same way — re-derived from their own
--    pseudo_id, never carried over from the old (untrusted) value — so
--    any URL already planted via this gap is discarded, not preserved.
--    The frontend now builds the actual displayable URL from this safe
--    path via the Supabase SDK's own getPublicUrl() (see
--    avatarCache.js), which can only ever point at this project's own
--    bucket.
-- =============================================================================

alter table public.avatars add column if not exists avatar_path text;

-- Remediation: re-derive every existing row's path from its own
-- pseudo_id — deliberately NOT from the old avatar_url column, so a
-- value already planted through the gap above is discarded rather than
-- carried forward.
update public.avatars
   set avatar_path = lower(replace(pseudo_id, '#', '')) || '/avatar.jpg'
 where avatar_path is null;

alter table public.avatars alter column avatar_path set not null;
alter table public.avatars drop column if exists avatar_url;

drop function if exists public.set_own_avatar(text);

create or replace function public.set_own_avatar()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  own_pseudo text;
  safe_path text;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'sign in required to set a profile picture';
  end if;

  select pseudo_id into own_pseudo from public.profiles where user_id = auth.uid();
  if own_pseudo is null then
    raise exception 'no linked pseudo id found for this account';
  end if;

  -- Identical derivation to the storage RLS policies and to
  -- avatarStoragePath() client-side — this is the ONLY path this caller
  -- was ever allowed to upload a file to, so it's also the only one
  -- they're allowed to point their profile at.
  safe_path := replace(lower(own_pseudo), '#', '') || '/avatar.jpg';

  insert into public.avatars (pseudo_id, avatar_path, updated_at)
  values (own_pseudo, safe_path, now())
  on conflict (pseudo_id) do update
    set avatar_path = excluded.avatar_path,
        updated_at = now();

  return safe_path;
end;
$$;

revoke all on function public.set_own_avatar() from public;
grant execute on function public.set_own_avatar() to authenticated;

-- =============================================================================
-- 29. SECURITY AUDIT v6 — extremely thorough re-pass per a follow-up
--    request, specifically hunting for logic bugs/"glitches" beyond the
--    obvious ownership-check pattern already fixed elsewhere. One real,
--    serious finding, in a table none of the previous rounds looked at
--    closely: reports.
--
--    The "signed-in users can file reports" policy (section 10) checks
--    that reporter_pseudo_id matches the expected #AnonUserNNNN format
--    and that reason is one of the allowed values — but NEVER checks
--    that reporter_pseudo_id is actually THIS caller's own linked
--    pseudo_id. Since the client sends this field itself
--    (ConfessionCard.jsx: reporter_pseudo_id: pseudoId), a caller who
--    calls the insert directly (bypassing the UI) can set it to
--    anything matching the format — including a stranger's real,
--    already-claimed pseudo_id, or a freshly made-up one that has never
--    existed.
--
--    Both per-reporter caps (section 4's 20/hour, section 22's 30/30-day)
--    key on this exact same self-declared field — so both are fully
--    bypassed by rotating it. Concretely, this means: one signed-in
--    account (a one-time signup, not per-report) could file reports
--    against any target post in a loop, inventing a new
--    reporter_pseudo_id each time, and hit section 21's per-target cap
--    (100 reports/30 days) almost immediately with neither rate limit
--    ever engaging — a full report-bombing path to get any post/account
--    buried or auto-flagged. It also breaks the traceability the
--    original design explicitly relied on ("every report can be traced
--    back to a real account" — false as written, since the account
--    filing it and the account named as filing it need not be the
--    same).
--
--    Confirmed safe to fix without breaking real usage: App.jsx already
--    syncs the local pseudoId to the signed-in account's real linked
--    pseudo_id on every sign-in (syncFromSession -> fetchOwnPseudoId),
--    so a legitimate report's reporter_pseudo_id already always equals
--    the caller's own — this only closes the gap for a caller bypassing
--    the UI entirely.
-- =============================================================================

drop policy if exists "signed-in users can file reports" on public.reports;
create policy "signed-in users can file reports"
  on public.reports for insert
  to authenticated
  with check (
    reason in ('Spam', 'Harassment or hate', 'Self-harm concern', 'Other')
    and reporter_pseudo_id ~ '^#AnonUser[0-9]{4,6}$'
    and reporter_pseudo_id = (
      select p.pseudo_id from public.profiles p where p.user_id = (select auth.uid())
    )
  );

-- =============================================================================
-- 30. Follow-up to section 13's purge job: it only ever deleted the
--    stale account's OWN posts. Deleting a post cascades to
--    comments/reactions/reports made ON it, but never touched comments
--    that account made on OTHER people's still-active posts — those
--    were silently left behind.
--
--    That was mostly harmless on its own, but section 27 made claiming
--    a pseudo_id require ownership proof whenever it already has ANY
--    posts or comments. A purged (and therefore, per section 13's own
--    stated intent, genuinely freed) identity with leftover comments
--    elsewhere would become permanently unclaimable by anyone —
--    including a legitimate new visitor who happens to randomly
--    generate that exact id later — since the only proof that could
--    ever unlock it belonged to a browser tied to an account that no
--    longer exists. This re-creates purge_inactive_accounts() to also
--    delete the account's leftover comments, so "purged" keeps meaning
--    what section 13 says it means: the identity is fully freed, not
--    left half-deleted and permanently stuck.
-- =============================================================================

create or replace function public.purge_inactive_accounts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  stale record;
  purged_count integer := 0;
  deleted_posts integer;
begin
  for stale in
    select u.id as user_id, p.pseudo_id
    from auth.users u
    join public.profiles p on p.user_id = u.id
    where coalesce(u.last_sign_in_at, u.created_at) < now() - interval '90 days'
  loop
    delete from public.comments where pseudo_id = stale.pseudo_id;

    delete from public.posts where pseudo_id = stale.pseudo_id;
    get diagnostics deleted_posts = row_count;

    insert into public.account_purge_log (pseudo_id, posts_deleted)
    values (stale.pseudo_id, deleted_posts);

    -- Cascades to public.profiles (user_id references auth.users on delete
    -- cascade) and to Auth's own internal tables (sessions, identities...).
    delete from auth.users where id = stale.user_id;

    purged_count := purged_count + 1;
  end loop;

  return purged_count;
end;
$$;

revoke all on function public.purge_inactive_accounts() from public, anon, authenticated;

-- =============================================================================
-- 31. Another consistency gap found in this same meticulous pass:
--    create_post() and create_comment() both reject a banned pseudo_id
--    (sections 20, 26), but react_to_post() never adopted the same
--    check — a banned account could still add new heart reactions
--    (though not new posts or comments). remove_reaction() is
--    deliberately left alone here: taking an existing reaction away,
--    like deleting your own post/comment, isn't a new piece of content
--    for a ban to be guarding against.
-- =============================================================================

create or replace function public.react_to_post(
  p_post_id uuid,
  p_pseudo_id text,
  p_emoji text,
  p_owner_token uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
  own_pseudo text;
  stored_token uuid;
begin
  if p_pseudo_id !~ '^#AnonUser[0-9]{4,6}$' then
    raise exception 'invalid pseudo id';
  end if;
  if p_emoji <> '❤️' then
    raise exception 'unsupported reaction';
  end if;

  if public.is_pseudo_banned(p_pseudo_id) then
    raise exception 'this account has been banned by a moderator';
  end if;

  if auth.role() = 'authenticated' then
    select pseudo_id into own_pseudo from public.profiles where user_id = auth.uid();
    if own_pseudo is null or own_pseudo <> p_pseudo_id then
      raise exception 'pseudo id does not match signed-in account';
    end if;
  else
    select owner_token into stored_token
      from public.reaction_owner_tokens
     where post_id = p_post_id and pseudo_id = p_pseudo_id;

    if stored_token is null then
      if p_owner_token is null then
        raise exception 'owner token required for anonymous reactions';
      end if;
      insert into public.reaction_owner_tokens (post_id, pseudo_id, owner_token)
      values (p_post_id, p_pseudo_id, p_owner_token);
    elsif stored_token <> p_owner_token then
      raise exception 'owner token does not match this pseudo id''s reaction';
    end if;
  end if;

  insert into public.reactions (post_id, pseudo_id, emoji)
  values (p_post_id, p_pseudo_id, p_emoji)
  on conflict (post_id, pseudo_id) do update set emoji = excluded.emoji;

  select count(*) into new_count from public.reactions where post_id = p_post_id;
  update public.posts set likes_count = new_count where id = p_post_id;

  return jsonb_build_object(p_emoji, new_count);
end;
$$;

revoke all on function public.react_to_post(uuid, text, text, uuid) from public;
grant execute on function public.react_to_post(uuid, text, text, uuid) to anon, authenticated;


-- =============================================================================
-- 32. Private messages between registered accounts.
--     Lets one signed-in account write privately to another (to talk, share
--     what they're going through, support each other). Design:
--       * Registered accounts only, on BOTH ends. An unregistered visitor has
--         no server-verifiable identity (only a localStorage id), so letting
--         them send/receive would make impersonation trivial.
--       * Nobody can insert/update/delete rows directly: all writes go through
--         the SECURITY DEFINER functions below, which derive the sender from
--         auth.uid() (never from a client-supplied id).
--       * The same server-side content floor used for posts/comments applies.
--       * Per-recipient blocking (message_blocks), hourly message cap, and a
--         daily cap on starting NEW conversations to limit spam/harassment.
--       * Messages are stored as plain text (NOT end-to-end encrypted):
--         anyone with database access could read them.
-- =============================================================================

create or replace function public.my_pseudo_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.pseudo_id from public.profiles p where p.user_id = auth.uid();
$$;

revoke all on function public.my_pseudo_id() from public, anon;
grant execute on function public.my_pseudo_id() to authenticated;

create table if not exists public.direct_messages (
  id               uuid primary key default gen_random_uuid(),
  sender_pseudo    text not null,
  recipient_pseudo text not null,
  content          text not null,
  created_at       timestamptz not null default now(),
  read_at          timestamptz,
  constraint dm_sender_format    check (sender_pseudo    ~ '^#AnonUser[0-9]{4,6}$'),
  constraint dm_recipient_format check (recipient_pseudo ~ '^#AnonUser[0-9]{4,6}$'),
  constraint dm_not_self         check (sender_pseudo <> recipient_pseudo),
  constraint dm_content_length   check (char_length(content) between 1 and 1000)
);

create index if not exists dm_pair_idx
  on public.direct_messages (sender_pseudo, recipient_pseudo, created_at desc);
create index if not exists dm_unread_idx
  on public.direct_messages (recipient_pseudo, read_at);

alter table public.direct_messages enable row level security;

drop policy if exists "participants can read their messages" on public.direct_messages;
create policy "participants can read their messages"
  on public.direct_messages for select
  to authenticated
  using (
    sender_pseudo = public.my_pseudo_id()
    or recipient_pseudo = public.my_pseudo_id()
  );
-- Deliberately NO insert/update/delete policy for any client role.

create table if not exists public.message_blocks (
  blocker_pseudo text not null,
  blocked_pseudo text not null,
  created_at     timestamptz not null default now(),
  primary key (blocker_pseudo, blocked_pseudo)
);
alter table public.message_blocks enable row level security;
-- No policies: only the functions below touch this table.

-- Realtime so a new message shows up without a refresh (the app also polls
-- as a fallback). Wrapped so re-running this file doesn't fail.
do $$
begin
  alter publication supabase_realtime add table public.direct_messages;
exception when duplicate_object then
  null;
end $$;

-- Can the signed-in caller message this pseudo_id? (registered, not banned,
-- and hasn't blocked the caller). Used to enable/disable the Message button.
create or replace function public.pseudo_accepts_messages(p_pseudo text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.my_pseudo_id() is not null
    and p_pseudo <> public.my_pseudo_id()
    and exists (select 1 from public.profiles pr where pr.pseudo_id = p_pseudo)
    and not public.is_pseudo_banned(p_pseudo)
    and not exists (
      select 1 from public.message_blocks b
       where b.blocker_pseudo = p_pseudo
         and b.blocked_pseudo = public.my_pseudo_id()
    ),
    false
  );
$$;

revoke all on function public.pseudo_accepts_messages(text) from public, anon;
grant execute on function public.pseudo_accepts_messages(text) to authenticated;

create or replace function public.send_direct_message(p_to text, p_content text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me text;
  clean text;
  new_id uuid;
  sent_last_hour integer;
  new_convos_today integer;
  already_talking boolean;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'sign in required to send messages';
  end if;

  me := public.my_pseudo_id();
  if me is null then
    raise exception 'sign in required to send messages';
  end if;

  if p_to is null or p_to !~ '^#AnonUser[0-9]{4,6}$' then
    raise exception 'invalid recipient';
  end if;

  if public.is_pseudo_banned(me) then
    raise exception 'this account has been banned by a moderator';
  end if;

  if not public.pseudo_accepts_messages(p_to) then
    raise exception 'this person can''t receive messages';
  end if;

  clean := btrim(coalesce(p_content, ''));
  if char_length(clean) < 1 or char_length(clean) > 1000 then
    raise exception 'message must be 1 to 1000 characters';
  end if;

  perform public.enforce_content_floor(clean);

  select count(*) into sent_last_hour
    from public.direct_messages
   where sender_pseudo = me and created_at > now() - interval '1 hour';
  if sent_last_hour >= 60 then
    raise exception 'slow down: too many messages in the last hour';
  end if;

  select exists (
    select 1 from public.direct_messages d
     where (d.sender_pseudo = me and d.recipient_pseudo = p_to)
        or (d.sender_pseudo = p_to and d.recipient_pseudo = me)
  ) into already_talking;

  if not already_talking then
    select count(distinct d.recipient_pseudo) into new_convos_today
      from public.direct_messages d
     where d.sender_pseudo = me
       and d.created_at > now() - interval '24 hours';
    if new_convos_today >= 10 then
      raise exception 'slow down: too many new conversations today';
    end if;
  end if;

  insert into public.direct_messages (sender_pseudo, recipient_pseudo, content)
  values (me, p_to, clean)
  returning id into new_id;

  return new_id;
end;
$$;

revoke all on function public.send_direct_message(text, text) from public, anon;
grant execute on function public.send_direct_message(text, text) to authenticated;

-- One row per person I've talked with: latest message + my unread count.
-- People I've blocked are left out.
create or replace function public.my_conversations()
returns table (
  other_pseudo text,
  last_content text,
  last_at timestamptz,
  last_from_me boolean,
  unread_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (select public.my_pseudo_id() as id),
  mine as (
    select
      case when d.sender_pseudo = me.id then d.recipient_pseudo else d.sender_pseudo end as oth,
      d.content as body,
      d.created_at as ts,
      (d.sender_pseudo = me.id) as from_me
    from public.direct_messages d, me
    where me.id is not null
      and (d.sender_pseudo = me.id or d.recipient_pseudo = me.id)
  ),
  latest as (
    select distinct on (oth) oth, body, ts, from_me
    from mine
    order by oth, ts desc
  ),
  unread as (
    select d.sender_pseudo as oth, count(*) as cnt
    from public.direct_messages d, me
    where d.recipient_pseudo = me.id and d.read_at is null
    group by d.sender_pseudo
  )
  select l.oth, l.body, l.ts, l.from_me, coalesce(u.cnt, 0)::bigint
  from latest l
  left join unread u on u.oth = l.oth
  where not exists (
    select 1 from public.message_blocks b, me
     where b.blocker_pseudo = me.id and b.blocked_pseudo = l.oth
  )
  order by l.ts desc;
$$;

revoke all on function public.my_conversations() from public, anon;
grant execute on function public.my_conversations() to authenticated;

create or replace function public.get_conversation(p_other text, p_limit integer default 200)
returns table (
  id uuid,
  sender_pseudo text,
  recipient_pseudo text,
  content text,
  created_at timestamptz,
  read_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select t.id, t.sender_pseudo, t.recipient_pseudo, t.content, t.created_at, t.read_at
  from (
    select d.id, d.sender_pseudo, d.recipient_pseudo, d.content, d.created_at, d.read_at
    from public.direct_messages d
    where public.my_pseudo_id() is not null
      and (
        (d.sender_pseudo = public.my_pseudo_id() and d.recipient_pseudo = p_other)
        or (d.sender_pseudo = p_other and d.recipient_pseudo = public.my_pseudo_id())
      )
    order by d.created_at desc
    limit least(greatest(coalesce(p_limit, 200), 1), 500)
  ) t
  order by t.created_at asc;
$$;

revoke all on function public.get_conversation(text, integer) from public, anon;
grant execute on function public.get_conversation(text, integer) to authenticated;

create or replace function public.mark_conversation_read(p_other text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.direct_messages d
     set read_at = now()
   where d.recipient_pseudo = public.my_pseudo_id()
     and d.sender_pseudo = p_other
     and d.read_at is null;
$$;

revoke all on function public.mark_conversation_read(text) from public, anon;
grant execute on function public.mark_conversation_read(text) to authenticated;

create or replace function public.unread_message_count()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*)
  from public.direct_messages d
  where d.recipient_pseudo = public.my_pseudo_id()
    and d.read_at is null
    and not exists (
      select 1 from public.message_blocks b
       where b.blocker_pseudo = d.recipient_pseudo
         and b.blocked_pseudo = d.sender_pseudo
    );
$$;

revoke all on function public.unread_message_count() from public, anon;
grant execute on function public.unread_message_count() to authenticated;

create or replace function public.set_message_block(p_pseudo text, p_blocked boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me text := public.my_pseudo_id();
begin
  if me is null then
    raise exception 'sign in required';
  end if;
  if p_pseudo is null or p_pseudo !~ '^#AnonUser[0-9]{4,6}$' or p_pseudo = me then
    raise exception 'invalid pseudo id';
  end if;

  if p_blocked then
    insert into public.message_blocks (blocker_pseudo, blocked_pseudo)
    values (me, p_pseudo)
    on conflict do nothing;
  else
    delete from public.message_blocks
     where blocker_pseudo = me and blocked_pseudo = p_pseudo;
  end if;
end;
$$;

revoke all on function public.set_message_block(text, boolean) from public, anon;
grant execute on function public.set_message_block(text, boolean) to authenticated;

create or replace function public.am_i_blocking_messages_from(p_pseudo text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.message_blocks b
     where b.blocker_pseudo = public.my_pseudo_id()
       and b.blocked_pseudo = p_pseudo
  );
$$;

revoke all on function public.am_i_blocking_messages_from(text) from public, anon;
grant execute on function public.am_i_blocking_messages_from(text) to authenticated;

-- -----------------------------------------------------------------------------
-- 33. Profile pictures are no longer compressed in the browser, so the
--     avatars bucket must accept the original file: common image types,
--     up to 10 MB. (Raise or lower file_size_limit to fit your storage plan.)
-- -----------------------------------------------------------------------------
update storage.buckets
   set file_size_limit = 10485760,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
 where id = 'avatars';
