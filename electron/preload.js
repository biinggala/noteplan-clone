// contextBridge로 필요한 Node API를 안전하게 노출할 수 있음
// 현재는 특별히 노출할 API 없음
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
})
