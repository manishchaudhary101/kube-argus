import { useState, useCallback } from 'react'

function readFavorites(email: string): string[] {
  const key = `kube-argus-fav-${email}`
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every(v => typeof v === 'string')) return parsed
    console.warn(`useFavorites: malformed data for ${key}, resetting`)
    return []
  } catch {
    console.warn(`useFavorites: failed to parse localStorage key ${key}, resetting`)
    return []
  }
}

function writeFavorites(email: string, favs: string[]) {
  try {
    localStorage.setItem(`kube-argus-fav-${email}`, JSON.stringify(favs))
  } catch {
    // localStorage unavailable — silently ignore
  }
}

export function useFavorites(email: string) {
  const [favorites, setFavorites] = useState<string[]>(() => readFavorites(email))

  const toggle = useCallback((ns: string) => {
    setFavorites(prev => {
      const next = prev.includes(ns) ? prev.filter(n => n !== ns) : [...prev, ns]
      writeFavorites(email, next)
      return next
    })
  }, [email])

  const isFavorite = useCallback((ns: string) => favorites.includes(ns), [favorites])

  return { favorites, toggle, isFavorite }
}
