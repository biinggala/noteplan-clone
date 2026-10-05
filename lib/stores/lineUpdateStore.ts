'use client'
import { create } from 'zustand'

/**
 * 타임라인에서 타임블록을 옮기거나 늘리거나 지웠을 때, 그 블록의 원래 줄(일간 노트)을
 * 고쳐 달라는 요청. 일간 노트 화면이 소비한다.
 *
 * 에디터에서 줄을 끌어다 놓는 경우는 여기를 거치지 않는다 — 끌어온 에디터에
 * 바로 고쳐 넣는다 (lib/dnd/pointerLineDrag.ts). 예전엔 그것도 여기 쌓았는데,
 * 주간·일반 노트에서 끌어오면 소비할 화면이 없어 쌓여 있다가 나중에 연
 * 아무 일간 노트에 적용됐다.
 */
export interface LineUpdate {
  /** 이 요청이 고칠 일간 노트의 날짜 (YYYY-MM-DD). 다른 날짜 노트에선 버린다 */
  date: string
  /** 찾을 줄 (앞뒤 공백 무시) */
  find: string
  /** 바꿀 내용. 들여쓰기는 원래 줄 것을 유지한다 */
  replace: string
  /** 알고 있으면 0-based 줄 번호 — 같은 내용 줄이 여럿일 때 이 줄을 우선 */
  lineIndex?: number
}

interface LineUpdateStore {
  /**
   * 큐인 이유: 여러 줄을 한 번에 타임라인에 떨어뜨리면 줄마다 수정 요청이
   * 하나씩 나온다. 예전처럼 한 건만 담아두면 뒤엣것이 앞엣것을 덮어써서
   * 마지막 줄만 시간이 붙었다.
   */
  pending: LineUpdate[]
  requestUpdate: (update: LineUpdate) => void
  clearUpdates: () => void
}

export const useLineUpdateStore = create<LineUpdateStore>((set) => ({
  pending: [],
  requestUpdate: (update) =>
    set(state => ({ pending: [...state.pending, update] })),
  clearUpdates: () => set({ pending: [] }),
}))
