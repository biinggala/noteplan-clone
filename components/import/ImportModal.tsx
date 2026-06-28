'use client'
import { useRef, useState, useCallback, useEffect } from 'react'
import type { Note } from '@/types/note'
import { readFilesAsNotes, countByType } from '@/lib/import/noteplanImport'
import { bulkImportNotes, ensureFolders } from '@/lib/db/noteRepository'

type Phase = 'idle' | 'parsed' | 'importing' | 'done'

interface ImportModalProps {
  onClose: () => void
}

export default function ImportModal({ onClose }: ImportModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [isDragOver, setIsDragOver] = useState(false)
  const [onConflict, setOnConflict] = useState<'skip' | 'overwrite'>('skip')

  // 폴더 선택 input에 webkitdirectory 속성 부여 (TSX 표준 속성 아님)
  useEffect(() => {
    const el = folderInputRef.current
    if (el) {
      el.setAttribute('webkitdirectory', '')
      el.setAttribute('directory', '')
    }
  }, [])

  // parsed 결과
  const [parsedNotes, setParsedNotes]       = useState<Note[]>([])
  const [skippedFiles, setSkippedFiles]     = useState<string[]>([])
  const [folderPaths, setFolderPaths]       = useState<string[]>([])

  // import 진행
  const [progress, setProgress]   = useState(0)   // 0~100
  const [result, setResult]       = useState<{ imported: number; skipped: number; errors: number } | null>(null)

  // ── 파일 파싱 ───────────────────────────────────────────────────────────────
  const handleFiles = useCallback(async (files: File[]) => {
    const txtFiles = files.filter(f => /\.(txt|md)$/i.test(f.name))
    if (txtFiles.length === 0) return
    const { notes, skippedFilenames, folderPaths } = await readFilesAsNotes(txtFiles)
    setParsedNotes(notes)
    setSkippedFiles(skippedFilenames)
    setFolderPaths(folderPaths)
    setPhase('parsed')
  }, [])

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(Array.from(e.target.files))
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    handleFiles(Array.from(e.dataTransfer.files))
  }

  // ── 임포트 실행 ─────────────────────────────────────────────────────────────
  const handleImport = async () => {
    setPhase('importing')
    setProgress(0)
    try {
      // PARA 하위 폴더 먼저 생성 (없으면 노트가 트리에 안 보임)
      await ensureFolders(folderPaths)
      const res = await bulkImportNotes(parsedNotes, {
        onConflict,
        onProgress: (done, total) => {
          setProgress(total > 0 ? Math.round((done / total) * 100) : 100)
        },
      })
      setResult(res)
      setPhase('done')
    } catch (err) {
      console.error('[ImportModal]', err)
      setResult({ imported: 0, skipped: 0, errors: parsedNotes.length })
      setPhase('done')
    }
  }

  const counts = countByType(parsedNotes)

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 w-[480px] max-w-[95vw] rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">NotePlan 백업 임포트</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              .txt 파일 (YYYYMMDD / YYYY-WNN / YYYY-MM 형식)
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4">

          {/* ── Phase: idle / parsed — 파일 선택 영역 ── */}
          {(phase === 'idle' || phase === 'parsed') && (
            <>
              {/* Drop zone */}
              <div
                className={`relative flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed py-8 transition-colors cursor-pointer
                  ${isDragOver
                    ? 'border-blue-400 bg-blue-500/10'
                    : 'border-[var(--border)] hover:border-blue-400/50 hover:bg-white/5'
                  }`}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setIsDragOver(true) }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={onDrop}
              >
                <svg className="w-8 h-8 text-[var(--text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                <p className="text-sm text-[var(--text-secondary)]">
                  {phase === 'parsed'
                    ? '다른 파일로 교체하려면 다시 드롭'
                    : '파일을 드래그하거나 클릭해서 선택'}
                </p>
                <p className="text-xs text-[var(--text-muted)]">.txt 또는 .md 파일 복수 선택 가능</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.md"
                  multiple
                  className="hidden"
                  onChange={onFileChange}
                />
                <input
                  ref={folderInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={onFileChange}
                />
              </div>

              {/* PARA 폴더(Notes) 통째로 선택 — 하위 폴더 구조 보존 */}
              <button
                onClick={(e) => { e.stopPropagation(); folderInputRef.current?.click() }}
                className="-mt-2 flex items-center justify-center gap-2 w-full py-2 rounded-lg
                  border border-[var(--border)] text-xs text-[var(--text-secondary)]
                  hover:bg-white/5 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                </svg>
                폴더 선택 (PARA — Projects/Areas/Resources/Archive)
              </button>

              {/* 파싱 결과 요약 */}
              {phase === 'parsed' && parsedNotes.length > 0 && (
                <div className="rounded-lg bg-white/5 border border-[var(--border)] p-3 flex flex-col gap-2">
                  <p className="text-xs font-semibold text-[var(--text-secondary)]">
                    파싱된 노트 <span className="text-blue-400">{parsedNotes.length}개</span>
                  </p>
                  <div className="grid grid-cols-2 gap-1 text-xs text-[var(--text-muted)]">
                    {counts.daily > 0   && <span>📅 Daily  <strong className="text-[var(--text-secondary)]">{counts.daily}</strong></span>}
                    {counts.weekly > 0  && <span>📆 Weekly <strong className="text-[var(--text-secondary)]">{counts.weekly}</strong></span>}
                    {counts.monthly > 0 && <span>🗓 Monthly <strong className="text-[var(--text-secondary)]">{counts.monthly}</strong></span>}
                    {counts.yearly > 0  && <span>📅 Yearly  <strong className="text-[var(--text-secondary)]">{counts.yearly}</strong></span>}
                    {counts.project > 0 && <span>📁 Project <strong className="text-[var(--text-secondary)]">{counts.project}</strong></span>}
                  </div>
                  {folderPaths.length > 0 && (
                    <p className="text-xs text-[var(--text-muted)]">
                      생성될 폴더 <strong className="text-[var(--text-secondary)]">{folderPaths.length}</strong>개 (PARA 하위 포함)
                    </p>
                  )}
                  {skippedFiles.length > 0 && (
                    <p className="text-xs text-amber-400/80">
                      ⚠ 형식 불일치로 제외된 파일 {skippedFiles.length}개
                    </p>
                  )}
                </div>
              )}

              {/* 중복 처리 옵션 */}
              {phase === 'parsed' && (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-[var(--text-muted)]">중복 노트 처리:</span>
                  <div className="flex rounded-md overflow-hidden bg-white/5 text-xs">
                    {(['skip', 'overwrite'] as const).map(opt => (
                      <button
                        key={opt}
                        onClick={() => setOnConflict(opt)}
                        className={`px-3 py-1.5 transition-colors
                          ${onConflict === opt
                            ? 'bg-blue-500/30 text-blue-300'
                            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                          }`}
                      >
                        {opt === 'skip' ? '건너뜀' : '덮어쓰기'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Import 버튼 */}
              {phase === 'parsed' && parsedNotes.length > 0 && (
                <button
                  onClick={handleImport}
                  className="w-full py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium transition-colors"
                >
                  {parsedNotes.length}개 노트 임포트
                </button>
              )}
            </>
          )}

          {/* ── Phase: importing — 진행바 ── */}
          {phase === 'importing' && (
            <div className="flex flex-col items-center gap-4 py-6">
              <svg className="w-8 h-8 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <p className="text-sm text-[var(--text-secondary)]">임포트 중... {progress}%</p>
              <div className="w-full bg-white/10 rounded-full h-1.5">
                <div
                  className="bg-blue-400 h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {/* ── Phase: done — 완료 결과 ── */}
          {phase === 'done' && result && (
            <div className="flex flex-col gap-4 py-2">
              <div className="flex flex-col items-center gap-2">
                {result.errors === 0 ? (
                  <svg className="w-10 h-10 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                ) : (
                  <svg className="w-10 h-10 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                )}
                <p className="text-sm font-semibold text-[var(--text-primary)]">임포트 완료</p>
              </div>
              <div className="rounded-lg bg-white/5 border border-[var(--border)] p-3 grid grid-cols-3 gap-2 text-center text-xs">
                <div>
                  <div className="text-lg font-bold text-green-400">{result.imported}</div>
                  <div className="text-[var(--text-muted)]">임포트됨</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-[var(--text-muted)]">{result.skipped}</div>
                  <div className="text-[var(--text-muted)]">중복 건너뜀</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-red-400">{result.errors}</div>
                  <div className="text-[var(--text-muted)]">오류</div>
                </div>
              </div>
              <button
                onClick={onClose}
                className="w-full py-2 rounded-lg bg-[var(--bg-tertiary)] hover:bg-white/10 text-sm text-[var(--text-secondary)] transition-colors"
              >
                닫기
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
