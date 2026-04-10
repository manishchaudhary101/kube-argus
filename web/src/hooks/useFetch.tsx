import { useState, useEffect, useCallback, useRef } from 'react'

const SWR_TTL = 30_000
const swrCache = new Map<string, { data: unknown; ts: number }>()

function swrHit<T>(url: string): T | undefined {
  const entry = swrCache.get(url)
  if (entry && Date.now() - entry.ts < SWR_TTL) return entry.data as T
  return undefined
}

export function useFetch<T>(url: string | null, ms = 0) {
  const [data, setData] = useState<T | null>(() => {
    if (!url) return null
    return swrHit<T>(url) ?? null
  })
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(() => {
    if (!url) return false
    return !swrHit<T>(url)
  })
  const refetch = useCallback(() => {
    if (!url) return
    fetch(url).then(async r => {
      if (r.status === 401) { window.location.href = '/auth/login'; return }
      const text = await r.text()
      if (!r.ok) {
        try { const j = JSON.parse(text); throw new Error(j.error || text) } catch (e: any) { if (e.message) throw e; throw new Error(text) }
      }
      try { return JSON.parse(text) } catch { throw new Error('Invalid response from server') }
    }).then(d => {
      if (d !== undefined) {
        swrCache.set(url, { data: d, ts: Date.now() })
        setData(d); setErr(null)
      }
    }).catch(e => setErr(e.message || String(e))).finally(() => setLoading(false))
  }, [url])
  useEffect(() => {
    if (!url) { setLoading(false); return }
    const hit = swrHit<T>(url)
    if (hit) { setData(hit); setLoading(false) }
    refetch()
    const id = ms > 0 ? setInterval(refetch, ms) : undefined
    return () => { if (id) clearInterval(id) }
  }, [url, ms, refetch])
  return { data, err, loading, refetch }
}

export async function post(url: string) {
  const r = await fetch(url, { method: 'POST' })
  if (r.status === 401) { window.location.href = '/auth/login'; throw new Error('unauthorized') }
  const text = await r.text()
  if (r.status === 403) {
    try { const body = JSON.parse(text); throw new Error(body.message || 'admin access required') } catch (e: any) { if (e.message) throw e; throw new Error('admin access required') }
  }
  if (!r.ok) throw new Error(text)
  if (!text) return {}
  try { return JSON.parse(text) } catch { throw new Error('Invalid response from server') }
}

export function useFullscreen() {
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)
  const enter = useCallback(() => {
    if (ref.current?.requestFullscreen) {
      ref.current.requestFullscreen().then(() => setActive(true)).catch(() => {})
    }
  }, [])
  const exit = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().then(() => setActive(false)).catch(() => {})
    else setActive(false)
  }, [])
  useEffect(() => {
    const h = () => setActive(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', h)
    return () => document.removeEventListener('fullscreenchange', h)
  }, [])
  return { ref, active, enter, exit }
}
