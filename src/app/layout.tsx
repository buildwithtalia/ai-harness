import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Eval Harness",
  description: "Multi-provider model evaluation harness",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <header className="border-b">
          <div className="mx-auto max-w-6xl px-6 py-4 flex items-center gap-6">
            <Link href="/" className="font-semibold tracking-tight">AI Eval Harness</Link>
            <nav className="flex items-center gap-4 text-sm text-muted-foreground">
              <Link href="/" className="hover:text-foreground">Runs</Link>
              <Link href="/compare" className="hover:text-foreground">Compare</Link>
              <Link href="/prompts" className="hover:text-foreground">Prompts</Link>
              <Link href="/new" className="hover:text-foreground">New run</Link>
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
