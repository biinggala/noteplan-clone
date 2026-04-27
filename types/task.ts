export type TaskStatus = 'open' | 'done' | 'cancelled' | 'scheduled'

export interface Task {
  id: string
  noteId: string
  content: string
  status: TaskStatus
  scheduledDate?: string  // >YYYY-MM-DD
  dueDate?: string
  tags: string[]
  mentions: string[]
  lineNumber: number
  indentLevel: number
}
