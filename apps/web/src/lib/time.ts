/** `just now`, `5m ago`, `3h ago`, `2d ago`. */
export function ago(ms: number, now = Date.now()) {
  const m = Math.max(0, Math.round((now - ms) / 60000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

/** A time ahead, in the owner's zone: `today 09:00`, `tomorrow 09:00`, `Monday 09:00`, `Dec 4 09:00`. */
export function upcoming(ms: number, now = Date.now()) {
  const at = new Date(ms)
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days <= 0) return `today ${time}`
  if (days === 1) return `tomorrow ${time}`
  if (days < 7) return `${at.toLocaleDateString([], { weekday: 'long' })} ${time}`
  return `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}
