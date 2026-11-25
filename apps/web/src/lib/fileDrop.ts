/** The part of a DOM node `dropOwner` reads (a plain object in tests). */
export interface TreeNode {
  parentNode: TreeNode | null
}

const path = (n: TreeNode) => {
  const out: TreeNode[] = []
  for (let x: TreeNode | null = n; x; x = x.parentNode) out.push(x)
  return out.reverse()
}

/**
 * Which of several composers a file dropped on `target` goes to: the one sharing the deepest ancestor with it (the worker panel's own
 * composer for a drop on the panel), the first one when none is nearer. Every composer listens on the window, so without this one drop
 * would attach (and upload) the file to each of them.
 */
export function dropOwner<T extends TreeNode>(forms: T[], target: TreeNode): T | undefined {
  const to = path(target)
  let best: T | undefined
  let bestDepth = -1
  for (const form of forms) {
    const from = path(form)
    let depth = 0
    while (depth < from.length && depth < to.length && from[depth] === to[depth]) depth++
    if (depth > bestDepth) {
      best = form
      bestDepth = depth
    }
  }
  return best
}

/** The composers on screen that take dropped files now, in the order they mounted. */
const zones = new Set<{ form: () => HTMLElement | null; enabled: () => boolean }>()

/** Registers a composer's form as a drop zone; returns the unregister. */
export function addDropZone(zone: { form: () => HTMLElement | null; enabled: () => boolean }) {
  zones.add(zone)
  return () => void zones.delete(zone)
}

/** The form a file dropped (or dragged) over `target` belongs to, among the composers taking files now. */
export function dropZoneFor(target: EventTarget | null): HTMLElement | undefined {
  const forms = [...zones].flatMap((z) => {
    const f = z.enabled() ? z.form() : null
    return f ? [f] : []
  })
  return target instanceof Node ? dropOwner(forms, target) : forms[0]
}
