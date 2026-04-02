export const FullscreenBtn = ({ active, onEnter, onExit }: { active: boolean; onEnter: () => void; onExit: () => void }) => (
  <button
    onClick={(e) => { e.stopPropagation(); active ? onExit() : onEnter() }}
    className="rounded-md p-1 text-gray-500 hover:text-neon-cyan hover:bg-hull-700/50 transition-all"
    title={active ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
  >
    {active ? (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
    ) : (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
    )}
  </button>
)
