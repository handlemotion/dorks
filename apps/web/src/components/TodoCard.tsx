import { createContext, useContext } from 'react'
import { CARD_BLEED } from './ShipCard'
import { CircleArrowRightIcon, CircleCheckIcon, CircleDashedIcon, type LucideIcon } from 'lucide-react'
import type { ProgressTask } from '../lib/progress'

// The agent's to-do list in the thread: a card where each run of to-do calls (`TodoWrite`, `TaskCreate`, `TaskUpdate`) happened,
// showing the whole list as that run left it. Unlike the ship card it is never pinned or shrunk: every card stays where the agent
// planned or ticked things off, and the newest one updates as the calls in its run land.

/** The list after each run of to-do calls, keyed by the run's first call (`taskSnapshots`). */
export const TaskSnapshots = createContext<ReadonlyMap<string, ProgressTask[]>>(new Map())

const LOOK: Record<ProgressTask['status'], { icon: LucideIcon; className: string; label: string }> = {
  // The strokes take the card's fill, so the check and the arrow read as cut out of a filled circle.
  completed: { icon: CircleCheckIcon, className: 'fill-muted-foreground/70 text-surface', label: 'Done' },
  in_progress: { icon: CircleArrowRightIcon, className: 'fill-foreground text-surface', label: 'In progress' },
  pending: { icon: CircleDashedIcon, className: 'text-muted-foreground', label: 'To do' },
}

/** The card for the run of to-do calls starting at `id`; null when the calls left no list to show (or carried no input). */
export function TodoCard({ id }: { id: string }) {
  const tasks = useContext(TaskSnapshots).get(id)
  if (!tasks?.length) return null
  const done = tasks.filter((t) => t.status === 'completed').length
  return (
    <section
      aria-label={`To-dos, ${done} of ${tasks.length} done`}
      data-testid="todos"
      className={`${CARD_BLEED} my-1.5 flex min-w-0 flex-col gap-1.5 rounded-[6px] border border-surface-line bg-surface pt-2.5 pb-2.5`}
    >
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>To-dos</span>
        <span className="tabular-nums">
          {done}/{tasks.length}
        </span>
      </p>
      <ul className="flex min-w-0 flex-col">
        {tasks.map((task, i) => {
          const look = LOOK[task.status]
          return (
            <li key={i} data-task={task.status} className="flex min-w-0 items-start gap-2 py-1 text-sm leading-5">
              <look.icon aria-label={look.label} className={`mt-0.5 size-4 shrink-0 ${look.className}`} />
              <span className={`min-w-0 break-words ${task.status === 'completed' ? 'text-muted-foreground line-through decoration-muted-foreground/60' : 'text-foreground'}`}>{task.content}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
