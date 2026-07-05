'use client'
import { useMemo, useState } from 'react'
import { parseTaskOutline, type TaskOutlineType } from '@/lib/parser/taskOutline'
import { useUIStore } from '@/lib/stores/uiStore'

interface TaskOutlinePanelProps {
  content: string
  title?: string
}

const ICON: Record<TaskOutlineType, string> = {
  open: '○',
  done: '●',
  cancelled: '⊘',
  scheduled: '→',
  checklist: '☐',
  'checklist-done': '☑',
}

function TaskIcon({ type }: { type: TaskOutlineType }) {
  const done = type === 'done' || type === 'checklist-done'
  const cancelled = type === 'cancelled'
  return (
    <span
      className={`inline-block w-4 text-center flex-shrink-0 ${
        done ? 'text-[var(--accent)]' : cancelled ? 'text-[var(--text-muted)]' : 'text-amber-500/70'
      }`}
    >
      {ICON[type]}
    </span>
  )
}

export default function TaskOutlinePanel({ content, title = '할 일 요약' }: TaskOutlinePanelProps) {
  const sections = useMemo(() => parseTaskOutline(content), [content])
  // 날짜를 이동해도(daily 페이지가 note===null인 순간 이 컴포넌트가 잠깐
  // 언마운트됐다 다시 마운트됨) 접힘 상태가 유지되도록 전역 store 사용
  const collapsed = useUIStore(s => s.weeklyOutlineCollapsed)
  const toggleCollapsed = useUIStore(s => s.toggleWeeklyOutlineCollapsed)
  const [collapsedSections, setCollapsedSections] = useState<Set<number>>(new Set())

  if (sections.length === 0) return null

  const toggleSection = (i: number) => {
    setCollapsedSections(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  return (
    <div className="mx-12 mt-3 rounded-lg border border-[var(--border)] bg-white/[0.02] overflow-hidden flex-shrink-0">
      <button
        onClick={toggleCollapsed}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
      >
        <span className={`inline-block transition-transform ${collapsed ? '-rotate-90' : ''}`}>⌄</span>
        {title}
        <span className="text-[var(--text-muted)] font-normal">
          ({sections.reduce((n, s) => n + s.tasks.length, 0)})
        </span>
      </button>

      {!collapsed && (
        <div className="px-3 pb-2.5 space-y-1.5">
          {sections.map((section, i) => {
            const sectionCollapsed = collapsedSections.has(i)
            return (
              <div key={i}>
                <button
                  onClick={() => toggleSection(i)}
                  className="flex items-center gap-1 text-sm font-bold text-amber-500/80 hover:text-amber-400 transition-colors"
                >
                  <span className={`inline-block text-xs transition-transform ${sectionCollapsed ? '-rotate-90' : ''}`}>⌄</span>
                  {section.header}
                </button>
                {!sectionCollapsed && (
                  <div className="pl-5 mt-0.5 space-y-0.5">
                    {section.tasks.map((task, j) => (
                      <div
                        key={j}
                        className={`flex items-start gap-2 text-sm ${
                          task.type === 'done' || task.type === 'checklist-done'
                            ? 'text-[var(--text-muted)] line-through'
                            : task.type === 'cancelled'
                            ? 'text-[var(--text-muted)] line-through'
                            : 'text-[var(--text-primary)]'
                        }`}
                      >
                        <TaskIcon type={task.type} />
                        <span className="min-w-0 break-words">{task.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
