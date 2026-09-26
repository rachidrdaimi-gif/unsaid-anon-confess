import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { getPseudoId } from './lib/pseudoId'
import { fetchOwnPseudoId } from './lib/authIdentity'
import { getBlockedIds, blockPseudoId, unblockPseudoId } from './lib/blocklist'
import TopNav from './components/TopNav'
import ConfessionForm from './components/ConfessionForm'
import ConfessionFeed from './components/ConfessionFeed'
import ProfilePanel from './components/ProfilePanel'
import NotificationsPanel from './components/NotificationsPanel'
import SearchPanel from './components/SearchPanel'
import AuthModal from './components/AuthModal'
import AdminPanel from './components/AdminPanel'

export default function App() {
  const [pseudoId, setPseudoId] = useState(getPseudoId)
  const [isSignedIn, setIsSignedIn] = useState(false)
  // Whether THIS signed-in account is a moderator — checked server-side via
  // am_i_admin() (see schema.sql section 17), never assumed client-side.
  // Only used to decide whether CommentThread shows a delete button on
  // every comment, not just the caller's own; the actual delete is
  // re-checked server-side regardless of what this says.
  const [isAdmin, setIsAdmin] = useState(false)
  const [refreshSignal, setRefreshSignal] = useState(0)
  const [activeTab, setActiveTab] = useState('home')
  const [authOpen, setAuthOpen] = useState(false)
  const [authInitialMode, setAuthInitialMode] = useState(null)
  const [adminOpen, setAdminOpen] = useState(false)
  // Which pseudo_id's profile is open, if any — null means closed, and
  // when open it may be either this browser's own id (from the PROFILE
  // button) or someone else's (from tapping their name/avatar on a post
  // or comment anywhere in the feed).
  const [viewingPseudoId, setViewingPseudoId] = useState(null)
  // Lifted up (rather than kept inside ConfessionFeed) so the "Blocked
  // users" list in ProfilePanel and the feed's own filtering always agree
  // on the current set, no matter which one last changed it.
  const [blockedIds, setBlockedIds] = useState(() => getBlockedIds())
  // Set once at startup from ?post=<id> in the URL (see ConfessionCard's
  // "Copy link" action) so a shared confession opens pinned at the top of
  // the home feed even if it's since scrolled off the normal page.
  const [focusPostId] = useState(() => new URLSearchParams(window.location.search).get('post'))

  function handleBlock(blockedPseudoId) {
    setBlockedIds(blockPseudoId(blockedPseudoId))
  }

  function handleUnblock(unblockedPseudoId) {
    setBlockedIds(unblockPseudoId(unblockedPseudoId))
  }

  function handleOpenProfile(targetPseudoId) {
    setViewingPseudoId(targetPseudoId ?? pseudoId)
  }

  useEffect(() => {
    let active = true

    async function syncFromSession(session) {
      if (session?.user) {
        const linkedPseudoId = await fetchOwnPseudoId(session.user.id)
        if (!active) return
        if (linkedPseudoId) {
          setPseudoId(linkedPseudoId)
          setIsSignedIn(true)
        }
        const { data: adminCheck } = await supabase.rpc('am_i_admin')
        if (active) setIsAdmin(Boolean(adminCheck))
      } else {
        setPseudoId(getPseudoId())
        setIsSignedIn(false)
        setIsAdmin(false)
      }
    }

    supabase.auth.getSession().then(({ data }) => syncFromSession(data.session))

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      syncFromSession(session)
      // Supabase lands the user back here with an active recovery session
      // after they click the emailed reset link — open straight to the
      // "choose a new password" screen instead of the normal sign-in form.
      if (event === 'PASSWORD_RECOVERY') {
        setAuthInitialMode('reset')
        setAuthOpen(true)
      }
    })

    return () => {
      active = false
      listener.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    function checkHash() {
      setAdminOpen(window.location.hash === '#admin')
    }
    checkHash()
    window.addEventListener('hashchange', checkHash)
    return () => window.removeEventListener('hashchange', checkHash)
  }, [])

  return (
    <div className="min-h-screen pb-16">
      <TopNav
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onOpenProfile={() => handleOpenProfile(pseudoId)}
      />

      <main className="mx-auto max-w-2xl px-4 pt-6 space-y-6">
        {activeTab === 'home' && (
          <>
            <ConfessionForm pseudoId={pseudoId} onPosted={() => setRefreshSignal((n) => n + 1)} />
            <ConfessionFeed
              refreshSignal={refreshSignal}
              pseudoId={pseudoId}
              blockedIds={blockedIds}
              onBlocked={handleBlock}
              focusPostId={focusPostId}
              onOpenProfile={handleOpenProfile}
              isAdmin={isAdmin}
              isSignedIn={isSignedIn}
              onRequestSignIn={() => setAuthOpen(true)}
            />
          </>
        )}
        {activeTab === 'liked' && (
          <ConfessionFeed
            refreshSignal={refreshSignal}
            pseudoId={pseudoId}
            blockedIds={blockedIds}
            onBlocked={handleBlock}
            onlyLiked
            onOpenProfile={handleOpenProfile}
            isAdmin={isAdmin}
            isSignedIn={isSignedIn}
            onRequestSignIn={() => setAuthOpen(true)}
          />
        )}
        {activeTab === 'search' && <SearchPanel onOpenProfile={handleOpenProfile} />}
        {activeTab === 'notifications' && <NotificationsPanel pseudoId={pseudoId} refreshSignal={refreshSignal} />}
      </main>

      <footer className="mx-auto max-w-2xl px-4 pt-10 text-center text-xs text-zinc-600">
        Everything here is anonymous. Signing in only keeps your id the same
        across devices — your real name and email are never shown here or
        attached to anything you post. A profile picture is optional, tied
        only to your anonymous id, and never linked back to your real
        identity.
      </footer>

      {viewingPseudoId && (
        <ProfilePanel
          pseudoId={viewingPseudoId}
          ownPseudoId={pseudoId}
          isSignedIn={isSignedIn}
          onClose={() => setViewingPseudoId(null)}
          onRequestSignIn={() => {
            setViewingPseudoId(null)
            setAuthOpen(true)
          }}
          refreshSignal={refreshSignal}
          blockedIds={blockedIds}
          onUnblock={handleUnblock}
          onBlock={handleBlock}
          isAdmin={isAdmin}
          onOpenProfile={handleOpenProfile}
        />
      )}

      {authOpen && (
        <AuthModal
          onClose={() => { setAuthOpen(false); setAuthInitialMode(null) }}
          currentPseudoId={pseudoId}
          initialMode={authInitialMode}
        />
      )}

      {adminOpen && (
        <AdminPanel
          onClose={() => {
            window.location.hash = ''
          }}
        />
      )}
    </div>
  )
}
