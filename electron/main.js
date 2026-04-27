const { app, BrowserWindow, shell, utilityProcess } = require('electron')
const path = require('path')
const http = require('http')

const isDev = process.env.NODE_ENV === 'development'
const PORT = 3456
let nextServerProcess = null

function waitForServer(url, retries = 40) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get(url, () => {
        resolve()
      }).on('error', () => {
        if (retries-- > 0) setTimeout(attempt, 500)
        else reject(new Error('Next.js server failed to start'))
      })
    }
    attempt()
  })
}

function startNextServer() {
  const serverPath = isDev
    ? path.join(__dirname, '../.next/standalone/server.js')
    : path.join(process.resourcesPath, 'nextjs-server/server.js')
  const serverCwd = isDev
    ? path.join(__dirname, '../.next/standalone')
    : path.join(process.resourcesPath, 'nextjs-server')

  // utilityProcess는 Electron 내장 Node.js를 사용 — 외부 node 실행파일 불필요
  nextServerProcess = utilityProcess.fork(serverPath, [], {
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'production',
    },
    cwd: serverCwd,
    stdio: 'pipe',
  })

  nextServerProcess.stdout?.on('data', (d) => console.log('[next]', d.toString()))
  nextServerProcess.stderr?.on('data', (d) => console.error('[next]', d.toString()))
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

  if (isDev) {
    win.loadURL('http://localhost:3000')
    win.webContents.openDevTools()
  } else {
    startNextServer()
    await waitForServer(`http://localhost:${PORT}`)
    win.loadURL(`http://localhost:${PORT}`)
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (nextServerProcess) nextServerProcess.kill()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (nextServerProcess) nextServerProcess.kill()
})
