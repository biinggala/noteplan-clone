import type { Metadata } from "next";
import "./globals.css";
import TauriTitlebarDrag from "@/components/TauriTitlebarDrag";
import TauriAuthDeepLink from "@/components/TauriAuthDeepLink";

export const metadata: Metadata = {
  title: "NotePlan Clone",
  description: "Markdown-based notes, tasks, and calendar",
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
        {children}
      </body>
    </html>
  );
}
