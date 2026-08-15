'use client'
import { create } from 'zustand'

interface LineUpdate {
  /** Exact trimmed line text to find in the note */
  find: string
  /** Replacement text. Use clean content (no time prefix) to strip the annotation. */
  replace: string
}

interface LineUpdateStore {
  /**
   * 큐인 이유: 여러 줄을 한 번에 타임라인에 떨어뜨리면 줄마다 수정 요청이
   * 하나씩 나온다. 예전처럼 한 건만 담아두면 뒤엣것이 앞엣것을 덮어써서
   * 마지막 줄만 시간이 붙었다.
   */
  pending: LineUpdate[]
  requestUpdate: (find: string, replace: string) => void
  clearUpdates: () => void
}

export const useLineUpdateStore = create<LineUpdateStore>((set) => ({
  pending: [],
  requestUpdate: (find, replace) =>
    set(state => ({ pending: [...state.pending, { find, replace }] })),
  clearUpdates: () => set({ pending: [] }),
}))
