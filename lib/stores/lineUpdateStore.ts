'use client'
import { create } from 'zustand'

interface LineUpdate {
  /** Exact trimmed line text to find in the note */
  find: string
  /** Replacement text. Use clean content (no time prefix) to strip the annotation. */
  replace: string
}

interface LineUpdateStore {
  pendingUpdate: LineUpdate | null
  requestUpdate: (find: string, replace: string) => void
  clearUpdate: () => void
}

export const useLineUpdateStore = create<LineUpdateStore>((set) => ({
  pendingUpdate: null,
  requestUpdate: (find, replace) => set({ pendingUpdate: { find, replace } }),
  clearUpdate: () => set({ pendingUpdate: null }),
}))
