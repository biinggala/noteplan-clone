'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { format } from 'date-fns'

export default function Home() {
  const router = useRouter()
  useEffect(() => {
    const today = format(new Date(), 'yyyy-MM-dd')
    router.replace(`/daily?date=${today}`)
  }, [router])

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-primary)] text-[var(--text-muted)]">
      Loading...
    </div>
  )
}
