// contextBridge로 필요한 Node API를 안전하게 노출
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,
  // OAuth URL을 시스템 기본 브라우저에서 열기
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // 딥링크(noteplan://) 콜백 수신 — main 프로세스가 보내줌
  onOAuthCallback: (callback) => {
    const handler = (_event, url) => callback(url)
    ipcRenderer.on('oauth-callback', handler)
    // cleanup 함수 반환
    return () => ipcRenderer.removeListener('oauth-callback', handler)
  },
})
