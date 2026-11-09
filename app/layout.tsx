import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { SandboxBadge } from "@/components/demo/SandboxBadge";
import { DemoModeBanner } from "@/components/demo/DemoModeBanner";
import "./globals.css";

// The mode banner must reflect the RUNTIME environment on every page.
// Without this, statically prerendered pages would bake in the build-time mode.
export const dynamic = "force-dynamic";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ConsultAI — Enterprise Consulting & Escrow OS",
  description: "AI-agent platform for vetted freelance consultants — PayPal Business Solutions",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
      suppressHydrationWarning
    >
      <head>
        <meta name="color-scheme" content="dark light" />
      </head>
      <body className="min-h-full flex flex-col bg-[#090c12] text-slate-100 font-sans selection:bg-blue-500/30 selection:text-white">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
          forcedTheme="dark"
          disableTransitionOnChange
        >
          <div className="flex flex-col border-b border-slate-800/80 bg-[#0b101b]">
            <DemoModeBanner />
            <SandboxBadge />
          </div>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
