'use client'
import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import LeftSidebar from '@/components/sidebar/LeftSidebar'

interface Props {
  open: boolean
  onClose: () => void
}

/** Slide-in left navigation drawer for mobile, wrapping the desktop LeftSidebar. */
export default function MobileDrawer({ open, onClose }: Props) {
  const pathname = usePathname()

  // Close whenever the route changes (a nav item was tapped).
  useEffect(() => { if (open) onClose() /* eslint-disable-next-line */ }, [pathname])

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-[120] bg-black/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            className="fixed top-0 left-0 bottom-0 z-[130] w-[82vw] max-w-[320px]
                       sidebar-glass border-r border-[var(--border)] overflow-y-auto"
            style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
            initial={{ x: '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={{ type: 'tween', duration: 0.22, ease: 'easeOut' }}
          >
            <LeftSidebar />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
