import { expect, it } from 'vite-plus/test'
import { dropOwner, type TreeNode } from './fileDrop'

const node = (parentNode: TreeNode | null = null): TreeNode => ({ parentNode })

// A crew chat shows the dork's composer and, in the details panel, a worker's: a file dropped on one must go to that one only.
it('a dropped file goes to the composer nearest where it landed, and only to one', () => {
  const app = node()
  const main = node(app)
  const mainForm = node(main)
  const mainThread = node(main)
  const panel = node(app)
  const workerForm = node(panel)
  const workerThread = node(panel)
  const sidebar = node(app)
  const forms = [mainForm, workerForm]

  expect(dropOwner(forms, node(mainThread))).toBe(mainForm)
  expect(dropOwner(forms, node(workerThread))).toBe(workerForm)
  expect(dropOwner(forms, workerForm)).toBe(workerForm)
  // Nowhere near either: the first one (the page's own chat).
  expect(dropOwner(forms, sidebar)).toBe(mainForm)
  expect(dropOwner([], sidebar)).toBeUndefined()
})
