import { useState, useEffect, useCallback, useRef } from 'react'

export function useFetch<T>(url: string | null, ms = 0) {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const refetch = useCallback(() => {
    if (!url) return
    fetch(url).then(async r => {
      if (r.status === 401) { window.location.href = '/auth/login'; return }
      if (!r.ok) {
        const body = await r.text().catch(() => r.statusText)
        try { const j = JSON.parse(body); throw new Error(j.error || body) } catch (e: any) { if (e.message) throw e; throw new Error(body) }
      }
      return r.json()
    }).then(d => { if (d !== undefined) { setData(d); setErr(null) } }).catch(e => setErr(e.message || String(e))).finally(() => setLoading(false))
  }, [url])
  useEffect(() => {
    if (!url) { setLoading(false); return }
    refetch()
    const id = ms > 0 ? setInterval(refetch, ms) : undefined
    return () => { if (id) clearInterval(id) }
  }, [url, ms, refetch])
  return { data, err, loading, refetch }
}

export async function post(url: string) {
  const r = await fetch(url, { method: 'POST' })
  if (r.status === 401) { window.location.href = '/auth/login'; throw new Error('unauthorized') }
  if (r.status === 403) {
    const body = await r.json().catch(() => ({ message: 'forbidden' }))
    throw new Error(body.message || 'admin access required')
  }
  if (!r.ok) throw new Error(await r.text())
  return r.json()
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
