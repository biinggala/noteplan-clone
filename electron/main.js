const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron')
const path = require('path')
const fs   = require('fs')
const http = require('http')
const https = require('https')

const isDev = process.env.NODE_ENV === 'development'
// STATIC_LOCAL=true → 패키징 없이 로컬 out/ 정적 서버로 실행 (검증용)
const staticLocal = process.env.STATIC_LOCAL === 'true'
const PORT  = 3456
const PROTOCOL = 'noteplan'   // 딥링크 스킴: noteplan://auth-callback
let staticServer = null
let mainWindow = null

// 정적 파일 MIME 타입
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.txt':  'text/plain; charset=utf-8',
  '.map':  'application/json',
}

// ── 커스텀 프로토콜 등록 (OAuth 딥링크용) ────────────────────────────────────
if (process.defaultApp) {
  // dev 모드: electron .  형태로 실행될 때 인자 포함해 등록
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL)
}

// 단일 인스턴스 보장 — 딥링크가 두 번째 인스턴스를 띄우지 않도록
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // Windows/Linux: 딥링크는 두 번째 인스턴스의 argv로 전달됨
  app.on('second-instance', (_event, argv) => {
    const url = argv.find(a => a.startsWith(`${PROTOCOL}://`))
    if (url) handleDeepLink(url)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// macOS: 딥링크는 open-url 이벤트로 전달됨
app.on('open-url', (_event, url) => {
  _event.preventDefault()
  handleDeepLink(url)
})

// 딥링크 → 렌더러로 전달
function handleDeepLink(url) {
  if (!url || !url.startsWith(`${PROTOCOL}://`)) return
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('oauth-callback', url)
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
}

// 정적 export(out/)를 서빙하는 경량 HTTP 서버 — 의존성 없음
function staticRoot() {
  return (isDev || staticLocal)
    ? path.join(__dirname, '../out')
    : path.join(process.resourcesPath, 'static-app')
}

function startStaticServer() {
  const root = staticRoot()
  staticServer = http.createServer((req, res) => {
    try {
      let pathname = decodeURIComponent(
        new URL(req.url, `http://localhost:${PORT}`).pathname
      )
      if (pathname.endsWith('/')) pathname += 'index.html'

      // 후보: 정확한 파일 → .html → /index.html → SPA fallback(index.html)
      const candidates = [
        path.join(root, pathname),
        path.join(root, pathname + '.html'),
        path.join(root, pathname, 'index.html'),
      ]
      let filePath = candidates.find(
        p => p.startsWith(root) && fs.existsSync(p) && fs.statSync(p).isFile()
      )
      if (!filePath) filePath = path.join(root, 'index.html') // 클라이언트 라우트 fallback

      const ext = path.extname(filePath).toLowerCase()
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
      fs.createReadStream(filePath).pipe(res)
    } catch (err) {
      res.writeHead(500)
      res.end('Internal error')
      console.error('[static]', err)
    }
  })
  return new Promise((resolve) => {
    staticServer.listen(PORT, '127.0.0.1', () => resolve())
  })
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a1a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  mainWindow = win

  // 페이지 로드 실패 시 콘솔에 기록 (검은 화면 디버깅용)
  win.webContents.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL) => {
    console.error(`[did-fail-load] ${errorCode} ${errorDesc} → ${validatedURL}`)
  })

  // DevTools: Cmd+Option+I
  win.webContents.on('before-input-event', (_, input) => {
    if (input.meta && input.alt && input.key === 'i') {
      win.webContents.openDevTools()
    }
  })

  // dev 모드(staticLocal 아님): Next dev 서버(localhost:3000) 로드
  if (isDev && !staticLocal) {
    win.loadURL('http://localhost:3000')
    win.webContents.openDevTools()
    return
  }

  // 정적 서버 모드: out/ 서빙 후 로드
  await startStaticServer()
  win.loadURL(`http://localhost:${PORT}`)
  if (staticLocal) win.webContents.openDevTools()

  // 페이지 로드될 때마다 드래그 영역 주입 (React/Next.js 완전 우회)
  const injectDragRegion = () => {
    // .electron-drag 클래스가 붙은 헤더 요소를 드래그 가능으로 지정
    // 그 안의 button/input 등 인터랙티브 요소는 no-drag로 명시적 해제
    win.webContents.insertCSS(`
      .electron-drag {
        -webkit-app-region: drag;
      }
      button, input, a, select, textarea, label,
      [role="button"], [role="textbox"], [role="searchbox"],
      .cm-content, .cm-editor, .cm-scroller {
        -webkit-app-region: no-drag;
      }
    `).catch(() => {})
  }

  win.webContents.on('did-finish-load', injectDragRegion)
  win.webContents.on('did-navigate-in-page', injectDragRegion)
}

function checkForUpdates() {
  const options = {
    hostname: 'api.github.com',
    path: '/repos/biinggala/noteplan-clone/releases/latest',
    headers: { 'User-Agent': 'NotePlan-Clone-App' },
  }
  https.get(options, (res) => {
    let data = ''
    res.on('data', chunk => data += chunk)
    res.on('end', () => {
      try {
        const release = JSON.parse(data)
        const latest  = (release.tag_name || '').replace('v', '')
        const current = app.getVersion()
        if (latest && latest !== current) {
          dialog.showMessageBox({
            type: 'info',
            title: '업데이트 사용 가능',
            message: `새 버전 v${latest}이 있습니다 (현재 v${current})`,
            detail: '지금 다운로드 페이지를 여시겠어요?',
            buttons: ['다운로드', '나중에'],
            defaultId: 0,
          }).then(({ response }) => {
            if (response === 0) shell.openExternal(release.html_url)
          })
        }
      } catch { /* 무시 */ }
    })
  }).on('error', () => { /* 오프라인 무시 */ })
}

app.whenReady().then(() => {
  // 렌더러 → 시스템 브라우저로 OAuth URL 열기
  ipcMain.handle('open-external', async (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      await shell.openExternal(url)
    }
  })

  createWindow()

  // Windows/Linux 콜드 스타트: 딥링크가 argv로 들어온 경우 처리
  const deepLinkArg = process.argv.find(a => a.startsWith(`${PROTOCOL}://`))
  if (deepLinkArg) setTimeout(() => handleDeepLink(deepLinkArg), 1000)

  // 30초 후 업데이트 체크 (앱 로딩 방해 안 되도록)
  setTimeout(checkForUpdates, 30_000)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (staticServer) staticServer.close()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (staticServer) staticServer.close()
})
