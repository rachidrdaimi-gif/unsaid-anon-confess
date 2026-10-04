import { useEffect, useRef, useState } from 'react'
import Avatar from './Avatar'

export default function TopNav({ pseudoId, activeTab, onTabChange, onOpenProfile, isSignedIn, authReady = true, onRequestSignIn }) {
  const tabs = [
    { id: 'home', label: 'Home', icon: HomeIcon },
    { id: 'search', label: 'Search', icon: SearchIcon },
    { id: 'liked', label: 'Liked', icon: HeartIcon },
    { id: 'notifications', label: 'Alerts', icon: BellIcon },
  ]

  // Hide the bar while scrolling down, reveal it again on scroll up —
  // gives the feed more room without losing quick access to navigation.
  const [hidden, setHidden] = useState(false)
  const lastY = useRef(0)

  useEffect(() => {
    lastY.current = window.scrollY
    function onScroll() {
      const y = window.scrollY
      if (y < 40) {
        setHidden(false)
      } else if (y > lastY.current) {
        // any downward movement, however small — inertial mobile scrolling
        // fires many tiny scroll events, so a magnitude threshold here
        // meant it rarely triggered
        setHidden(true)
      } else if (y < lastY.current) {
        setHidden(false)
      }
      lastY.current = y
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div
      className={`sticky top-0 z-30 mx-auto max-w-2xl px-4 pt-6 pb-2 bg-base-950/80 backdrop-blur transition-transform duration-300 ${
        hidden ? '-translate-y-[calc(100%+1rem)]' : 'translate-y-0'
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center justify-between rounded-2xl border border-hush-500/30 bg-base-900/70 px-3 py-3 shadow-lg shadow-hush-500/5">
          <span className="truncate font-display text-lg font-medium text-zinc-50">
            Unspoken
          </span>
          <div className="flex shrink-0 items-center">
            {tabs.map((tab) => {
              const Icon = tab.icon
              const active = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onTabChange(tab.id)}
                  aria-pressed={active}
                  className={`flex items-center gap-1.5 rounded-full px-2 py-1.5 text-xs font-medium transition ${
                    active ? 'text-hush-300' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  <Icon className="h-4 w-4" filled={active} />
                  <span className="hidden sm:inline">{tab.label}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Profile button for everyone — signed in or not. Visitors without an
            account see the posts made from this browser's anonymous id, and
            can sign in from inside the profile panel. */}
        {authReady && (
          <button
            type="button"
            onClick={onOpenProfile}
            className="flex shrink-0 flex-col items-center gap-1 rounded-2xl border border-white/10 bg-base-900/70 px-3 py-3 text-zinc-400 hover:text-zinc-200"
          >
            <Avatar
              pseudoId={pseudoId}
              size={28}
              fallback={
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <circle cx="12" cy="8" r="4" />
                  <path strokeLinecap="round" d="M4 20c0-4 3.5-6 8-6s8 2 8 6" />
                </svg>
              }
            />
            <span className="text-[10px] font-medium tracking-wide">PROFILE</span>
          </button>
        )}
      </div>
    </div>
  )
}

function HomeIcon({ className, filled }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="7" height="7" rx="1.5" fill={filled ? 'currentColor' : 'none'} />
      <rect x="14" y="3" width="7" height="7" rx="1.5" fill={filled ? 'currentColor' : 'none'} />
      <rect x="3" y="14" width="7" height="7" rx="1.5" fill={filled ? 'currentColor' : 'none'} />
      <rect x="14" y="14" width="7" height="7" rx="1.5" fill={filled ? 'currentColor' : 'none'} />
    </svg>
  )
}

function SearchIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="11" r="7" />
      <path strokeLinecap="round" d="m20 20-3.5-3.5" />
    </svg>
  )
}

function HeartIcon({ className, filled }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 20.727c-.313 0-.625-.096-.879-.288C7.83 18.14 3 13.943 3 9.545 3 6.484 5.36 4 8.25 4c1.68 0 3.176.82 4.125 2.09A5.06 5.06 0 0 1 15.75 4C18.64 4 21 6.484 21 9.545c0 4.398-4.83 8.595-8.121 10.894a1.5 1.5 0 0 1-.879.288Z" />
    </svg>
  )
}

function BellIcon({ className, filled }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5m6 0v1a3 3 0 1 1-6 0v-1m6 0H9" />
    </svg>
  )
}
