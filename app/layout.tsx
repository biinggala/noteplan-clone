import type { Metadata } from "next";
import "./globals.css";
import TauriTitlebarDrag from "@/components/TauriTitlebarDrag";

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
        {children}
      </body>
    </html>
  );
}
