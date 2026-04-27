'use client'
import { create } from 'zustand'

interface UIStore {
  leftSidebarWidth: number
  rightSidebarWidth: number
  leftSidebarVisible: boolean
  rightSidebarVisible: boolean
  commandBarOpen: boolean
  activeTab: 'notes' | 'tags' | 'review'
  expandedFolders: string[]
  setLeftSidebarWidth: (w: number) => void
  setRightSidebarWidth: (w: number) => void
  toggleLeftSidebar: () => void
  toggleRightSidebar: () => void
  setCommandBarOpen: (open: boolean) => void
  setActiveTab: (tab: 'notes' | 'tags' | 'review') => void
  toggleFolder: (id: string) => void
  expandFolder: (id: string) => void
}

export const useUIStore = create<UIStore>((set) => ({
  leftSidebarWidth: 240,
  rightSidebarWidth: 260,
  leftSidebarVisible: true,
  rightSidebarVisible: true,
  commandBarOpen: false,
  activeTab: 'notes',
  expandedFolders: [],
  setLeftSidebarWidth: (w) => set({ leftSidebarWidth: w }),
  setRightSidebarWidth: (w) => set({ rightSidebarWidth: w }),
  toggleLeftSidebar: () => set((s) => ({ leftSidebarVisible: !s.leftSidebarVisible })),
  toggleRightSidebar: () => set((s) => ({ rightSidebarVisible: !s.rightSidebarVisible })),
  setCommandBarOpen: (open) => set({ commandBarOpen: open }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  toggleFolder: (id) => set((s) => ({
    expandedFolders: s.expandedFolders.includes(id)
      ? s.expandedFolders.filter(f => f !== id)
      : [...s.expandedFolders, id],
  })),
  expandFolder: (id) => set((s) => ({
    expandedFolders: s.expandedFolders.includes(id) ? s.expandedFolders : [...s.expandedFolders, id],
  })),
}))
