import type { Metadata } from "next";
import "./globals.css";

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
        {children}
      </body>
    </html>
  );
}
