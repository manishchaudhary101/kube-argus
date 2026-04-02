import { useState, useCallback, useRef } from 'react'

export function useAIStream() {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const run = useCallback(async (url: string, body?: object) => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setText('')
    setError(null)
    setLoading(true)

    try {
      const resp = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
      if (!resp.ok) {
        const err = await resp.text()
        try { setError(JSON.parse(err).error || err) } catch { setError(err) }
        setLoading(false)
        return
      }

      const reader = resp.body?.getReader()
      const decoder = new TextDecoder()
      if (!reader) { setError('No response stream'); setLoading(false); return }

      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const parsed = JSON.parse(line.slice(6))
            if (parsed.done) break
            if (parsed.text) setText(prev => prev + parsed.text)
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message)
    }
    setLoading(false)
  }, [])

  const cancel = useCallback(() => { abortRef.current?.abort(); setLoading(false) }, [])

  return { text, loading, error, run, cancel }
}

export function simpleMarkdown(md: string): string {
  let html = md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^\- (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/gs, m => '<ul>' + m + '</ul>')
    .replace(/\n{2,}/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')

  // Simple table support
  html = html.replace(/(<br\/>)?\|(.+)\|(<br\/>)\|[-| ]+\|(<br\/>)([\s\S]*?)(?=<br\/><br\/>|<h|$)/g, (_, _pre, header, _br1, _br2, body) => {
    const headers = header.split('|').map((h: string) => `<th>${h.trim()}</th>`).join('')
    const rows = body.split('<br/>').filter((r: string) => r.includes('|')).map((row: string) => {
      const cells = row.split('|').map((c: string) => `<td>${c.trim()}</td>`).join('')
      return `<tr>${cells}</tr>`
    }).join('')
    return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`
  })

  return html
}
