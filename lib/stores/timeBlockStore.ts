'use client'
import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { ParsedTimeBlock } from '@/lib/parser/timeBlockParser'

export interface TimeBlock {
  id: string
  date: string        // YYYY-MM-DD
  startHour: number   // 0-23
  startMinute: number // 0, 15, 30, or 45
  duration: number    // minutes, multiple of 15 (min 15)
  content: string          // clean task text for timeline display (no time prefix, no bullet)
  color: string
  noteLineText?: string    // full line in note, e.g. "- [ ] 2:30 PM - 3:00 PM content"
  originalContent?: string // raw content AFTER the time range, e.g. "content"
  linePrefix?: string      // text BEFORE the time range, e.g. "- [ ] " or ""
}

const BLOCK_COLORS = [
  '#3b82f6', // blue-500
  '#6366f1', // indigo-500
  '#8b5cf6', // violet-500
  '#0ea5e9', // sky-500
  '#06b6d4', // cyan-500
  '#60a5fa', // blue-400
]
let _colorIdx = 0

interface TimeBlockStore {
  timeBlocks: TimeBlock[]
  addTimeBlock: (block: Omit<TimeBlock, 'id' | 'color'>) => void
  removeTimeBlock: (id: string) => void
  updateTimeBlock: (id: string, updates: Partial<TimeBlock>) => void
  /** Replace all time blocks for a date with the parsed set from note content. */
  syncTimeBlocks: (date: string, parsed: ParsedTimeBlock[]) => void
}

export const useTimeBlockStore = create<TimeBlockStore>((set) => ({
  timeBlocks: [],

  addTimeBlock: (block) =>
    set((state) => ({
      timeBlocks: [
        ...state.timeBlocks,
        {
          ...block,
          id: uuidv4(),
          color: BLOCK_COLORS[_colorIdx++ % BLOCK_COLORS.length],
        },
      ],
    })),

  removeTimeBlock: (id) =>
    set((state) => ({
      timeBlocks: state.timeBlocks.filter((b) => b.id !== id),
    })),

  updateTimeBlock: (id, updates) =>
    set((state) => ({
      timeBlocks: state.timeBlocks.map((b) =>
        b.id === id ? { ...b, ...updates } : b
      ),
    })),

  syncTimeBlocks: (date, parsed) =>
    set((state) => {
      const existing = state.timeBlocks.filter((b) => b.date === date)
      const other = state.timeBlocks.filter((b) => b.date !== date)

      const usedIds = new Set<string>()
      const newBlocks: TimeBlock[] = parsed.map((p) => {
        // Preserve id + color for blocks with same time + content (stable keys)
        // Each existing block can only be matched once to prevent duplicate IDs
        const match = existing.find(
          (b) =>
            !usedIds.has(b.id) &&
            b.startHour === p.startHour &&
            b.startMinute === p.startMinute &&
            b.content === p.content,
        )
        if (match) {
          usedIds.add(match.id)
          return {
            ...match,
            duration: p.duration,
            noteLineText: p.lineText,
            originalContent: p.originalContent,
            linePrefix: p.linePrefix,
          }
        }
        return {
          id: uuidv4(),
          date,
          startHour: p.startHour,
          startMinute: p.startMinute,
          duration: p.duration,
          content: p.content,
          noteLineText: p.lineText,
          originalContent: p.originalContent,
          linePrefix: p.linePrefix,
          color: BLOCK_COLORS[_colorIdx++ % BLOCK_COLORS.length],
        }
      })

      return { timeBlocks: [...other, ...newBlocks] }
    }),
}))
