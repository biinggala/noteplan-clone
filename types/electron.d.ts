export interface ElectronAPI {
  platform: string
  isElectron: true
  openExternal: (url: string) => Promise<void>
  /** 딥링크 OAuth 콜백 수신. cleanup 함수를 반환. */
  onOAuthCallback: (callback: (url: string) => void) => () => void
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}
