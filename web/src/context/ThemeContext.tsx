import { createContext, useContext, useState, useEffect, useMemo, useCallback, type ReactNode } from 'react'

export type Theme = 'dark' | 'notion'

interface ThemeCtxValue {
  theme: Theme
  setTheme: (t: Theme) => void
  toggle: () => void
}

const ThemeCtx = createContext<ThemeCtxValue>({ theme: 'dark', setTheme: () => {}, toggle: () => {} })

export const useTheme = () => useContext(ThemeCtx)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try { return (localStorage.getItem('ka-theme') as Theme) || 'dark' } catch { return 'dark' }
  })

  useEffect(() => {
    document.documentElement.classList.add('theme-switching')
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem('ka-theme', theme) } catch {}
    const id = setTimeout(() => document.documentElement.classList.remove('theme-switching'), 400)
    return () => clearTimeout(id)
  }, [theme])

  const setTheme = useCallback((t: Theme) => setThemeState(t), [])
  const toggle = useCallback(() => setThemeState(prev => (prev === 'dark' ? 'notion' : 'dark')), [])
  const value = useMemo(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle])

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>
}
