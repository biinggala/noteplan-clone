export type NoteType = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'project'

export interface Note {
  id: string
  type: NoteType
  title: string
  content: string
  date?: string           // YYYY-MM-DD (daily/weekly/monthly/yearly)
  filePath: string        // Calendar/20260306.md or Notes/MyNote.md
  folder?: string         // 폴더 경로
  tags: string[]
  mentions: string[]
  backlinks: string[]
  createdAt: number       // timestamp
  updatedAt: number       // timestamp
}

export interface Folder {
  id: string
  name: string
  parentId?: string
  path: string
}
