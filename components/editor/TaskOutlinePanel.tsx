'use client'
import { useMemo, useState, memo } from 'react'
import { parseTaskOutline, type TaskOutlineTask, type TaskOutlineType } from '@/lib/parser/taskOutline'
import { useUIStore } from '@/lib/stores/uiStore'

interface TaskOutlinePanelProps {
  content: string
  title?: string
  onToggleTask?: (task: TaskOutlineTask) => void
}

const ICON: Record<TaskOutlineType, string> = {
  open: '○',
  done: '●',
  cancelled: '⊘',
  scheduled: '→',
  checklist: '☐',
  'checklist-done': '☑',
}

const TOGGLEABLE: TaskOutlineType[] = ['open', 'done', 'checklist', 'checklist-done']

const LABEL: Record<TaskOutlineType, string> = {
  open: '할 일',
  done: '완료한 할 일',
  cancelled: '취소한 할 일',
  scheduled: '미룬 할 일',
  checklist: '체크리스트',
  'checklist-done': '완료한 체크리스트',
}

function TaskIcon({ type, text, onClick }: { type: TaskOutlineType; text: string; onClick?: () => void }) {
  const done = type === 'done' || type === 'checklist-done'
  const cancelled = type === 'cancelled'
  const clickable = !!onClick && TOGGLEABLE.includes(type)
  return (
    <span
      role="checkbox"
      aria-checked={done ? true : cancelled ? 'mixed' : false}
      aria-disabled={clickable ? undefined : true}
      aria-label={`${LABEL[type]}: ${text}`}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onClick : undefined}
      onKeyDown={clickable ? (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          onClick?.()
        }
      } : undefined}
      className={`inline-block w-4 text-center flex-shrink-0 rounded-sm ${clickable ? 'cursor-pointer hover:opacity-70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-1' : ''}`}
      style={{ color: done ? 'var(--accent)' : cancelled ? 'var(--text-muted)' : 'var(--accent)', opacity: done ? 1 : cancelled ? 1 : 0.65 }}
    >
      <span aria-hidden="true">{ICON[type]}</span>
    </span>
  )
}

function TaskOutlinePanel({ content, title = '할 일 요약', onToggleTask }: TaskOutlinePanelProps) {
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
    <div
      className="mx-12 mt-3 rounded-lg border border-[var(--border)] overflow-hidden flex-shrink-0"
      style={{ backgroundColor: 'var(--bg-tertiary)', borderTop: '2px solid var(--accent)' }}
    >
      <button
        onClick={toggleCollapsed}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors"
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
                  className="flex items-center gap-1 text-sm font-bold hover:opacity-80 transition-opacity"
                  style={{ color: 'var(--accent)' }}
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
                        <TaskIcon type={task.type} text={task.text} onClick={onToggleTask ? () => onToggleTask(task) : undefined} />
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

// 본문을 칠 때마다 페이지가 다시 그려져도, 받는 값(제목 등)이 그대로면 다시 그리지 않는다
export default memo(TaskOutlinePanel)
