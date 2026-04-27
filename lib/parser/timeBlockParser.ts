// Parses lines of the form:
//   NEW (preferred): "- [ ] 2:30 PM - 3:00 PM content"
//   OLD (legacy):    "2:30 PM - 3:00 PM content"
// Used for bidirectional sync between note content and the Day Timeline.

export interface ParsedTimeBlock {
  startHour: number
  startMinute: number
  duration: number  // minutes
  content: string          // clean text for timeline display (task prefix stripped)
  originalContent: string  // raw content after time range (may NOT include task prefix in new format)
  linePrefix: string       // text before the time range, e.g. "- [ ] " or "" (includes trailing space)
  lineText: string         // the full original line as it appears in the note
}

// Group 1: optional task/bullet marker before the time  (e.g. "- [ ] ", "* ", "+ ")
// Groups 2-7: time range (HH:MM AM/PM - HH:MM AM/PM)
// Group 8: content after the time range
const TIME_BLOCK_RE =
  /^(\s*(?:-\s*\[.?\]\s+|-\s+|\*\s+|\+\s+))?(\d{1,2}):(\d{2})\s*(AM|PM)\s*[-–]\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s+(.+)/i

const TASK_PREFIX_RE = /^\s*-\s*\[.?\]\s*/
const BULLET_PREFIX_RE = /^\s*[-*+]\s*/

function to24h(h: number, meridiem: string): number {
  const m = meridiem.toUpperCase()
  if (m === 'PM' && h !== 12) return h + 12
  if (m === 'AM' && h === 12) return 0
  return h
}

export function parseTimeBlockLines(content: string): ParsedTimeBlock[] {
  const result: ParsedTimeBlock[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    const m = TIME_BLOCK_RE.exec(trimmed)
    if (!m) continue
    const sh = to24h(parseInt(m[2]), m[4])
    const sm = parseInt(m[3])
    const eh = to24h(parseInt(m[5]), m[7])
    const em = parseInt(m[6])
    const originalContent = m[8].trim()
    // Strip task/bullet prefix for clean timeline display
    const cleanContent = originalContent
      .replace(TASK_PREFIX_RE, '')
      .replace(BULLET_PREFIX_RE, '')
      .trim()
    // linePrefix = the text before the time range (may be "" for old format)
    const linePrefix = m[1] ?? ''
    // Fix midnight wrap-around: end time may be on the next day (e.g. 11:30 PM - 12:30 AM)
    let duration = eh * 60 + em - (sh * 60 + sm)
    if (duration <= 0) duration += 24 * 60
    if (duration > 0 && cleanContent) {
      result.push({
        startHour: sh,
        startMinute: sm,
        duration,
        content: cleanContent,
        originalContent,
        linePrefix,
        lineText: trimmed,
      })
    }
  }
  return result
}

/** Returns "2:30 PM - 3:00 PM" given startHour=14, startMinute=30, duration=30 */
export function formatTimeRange(
  startHour: number,
  startMinute: number,
  duration: number,
): string {
  const endTotal = startHour * 60 + startMinute + duration
  const eh = Math.floor(endTotal / 60) % 24
  const em = endTotal % 60
  const fmt = (h: number, m: number) => {
    const p = h >= 12 ? 'PM' : 'AM'
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
    return `${h12}:${m.toString().padStart(2, '0')} ${p}`
  }
  return `${fmt(startHour, startMinute)} - ${fmt(eh, em)}`
}
