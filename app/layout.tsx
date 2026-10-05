import type { Metadata, Viewport } from "next";
import "./globals.css";
import TauriTitlebarDrag from "@/components/TauriTitlebarDrag";
import TauriAuthDeepLink from "@/components/TauriAuthDeepLink";
import TauriUpdater from "@/components/TauriUpdater";
import PWARegister from "@/components/PWARegister";

export const metadata: Metadata = {
  title: "NotePlan Clone",
  description: "Markdown-based notes, tasks, and calendar",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "NotePlan",
  },
  icons: {
    apple: "/icons/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#1a1a1a",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover", // 노치/safe-area 대응
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        {/* Pretendard (SIL OFL 1.1) — 글자 범위별로 나눠 필요한 조각만 받는다. 앱에 번들돼 오프라인에서도 동작 */}
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        <link rel="stylesheet" href="/fonts/pretendard/pretendardvariable-dynamic-subset.css" />
      </head>
      <body suppressHydrationWarning>
        <TauriTitlebarDrag />
        <TauriAuthDeepLink />
        <TauriUpdater />
        <PWARegister />
        {children}
      </body>
    </html>
  );
}
