import type { ReactNode } from 'react'

/**
 * One settings group: a heading (an h2 inside a section, which the e2e and screen readers rely on) and its content, flat on the app fill.
 * Groups are split by full-width dividers, not cards. Used by Settings and by a build's page.
 */
export function Group({ title, children, label }: { title: string; children: ReactNode; label?: string }) {
  return (
    <section className="border-b last:border-b-0" aria-label={label}>
      <div className="mx-auto grid w-full max-w-3xl gap-4 px-6 py-6 md:grid-cols-[12rem_1fr]">
        <h2 className="text-sm font-medium">{title}</h2>
        <div className="settings-group min-w-0">{children}</div>
      </div>
    </section>
  )
}
