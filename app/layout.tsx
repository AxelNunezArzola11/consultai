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
  title: "ConsultAI",
  description: "AI-agent platform for vetted freelance consultants — PayPal Business Solutions",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-[#181d1f] text-slate-100">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
          forcedTheme="dark"
          disableTransitionOnChange
        >
          <DemoModeBanner />
          <SandboxBadge />
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
