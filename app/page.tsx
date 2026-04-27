import { redirect } from 'next/navigation'
import { format } from 'date-fns'

export default function Home() {
  const today = format(new Date(), 'yyyy-MM-dd')
  redirect(`/daily/${today}`)
}
