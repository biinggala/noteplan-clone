'use client'
import { create } from 'zustand'
import type { Note } from '@/types/note'

interface NoteStore {
  activeNote: Note | null
  notes: Note[]
  setActiveNote: (note: Note | null) => void
  setNotes: (notes: Note[]) => void
  updateNote: (id: string, updates: Partial<Note>) => void
}

export const useNoteStore = create<NoteStore>((set) => ({
  activeNote: null,
  notes: [],
  setActiveNote: (note) => set({ activeNote: note }),
  setNotes: (notes) => set({ notes }),
  updateNote: (id, updates) =>
    set((state) => ({
      notes: state.notes.map((n) => (n.id === id ? { ...n, ...updates } : n)),
      activeNote:
        state.activeNote?.id === id
          ? { ...state.activeNote, ...updates }
          : state.activeNote,
    })),
}))
