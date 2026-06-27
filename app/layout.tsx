import type { Metadata, Viewport } from "next";
import "./globals.css";
import TauriTitlebarDrag from "@/components/TauriTitlebarDrag";
import TauriAuthDeepLink from "@/components/TauriAuthDeepLink";
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
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <TauriTitlebarDrag />
        <TauriAuthDeepLink />
        <PWARegister />
        {children}
      </body>
    </html>
  );
}
