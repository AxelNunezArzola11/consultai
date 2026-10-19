"use client";

/**
 * StyleGuideClient — renders all design system components for visual review.
 * Loaded from /dev/ui page which is DEMO_MODE gated.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter, CardAction } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { ThemeToggle } from "@/components/shared/ThemeToggle";

// ---------------------------------------------------------------------------
// Accent swatch helper
// ---------------------------------------------------------------------------

function AccentSwatch({
  label,
  bg,
  fg,
  ratio,
}: {
  label: string;
  bg: string;
  fg: string;
  ratio: string;
}) {
  return (
    <div
      className="rounded-lg px-4 py-3 text-sm font-medium flex items-center justify-between"
      style={{ background: `var(${bg})`, color: `var(${fg})` }}
    >
      <span>{label}</span>
      <span className="text-xs opacity-70">{ratio}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold tracking-tight border-b pb-2">{title}</h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function StyleGuideClient() {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster />

      <div className="max-w-3xl mx-auto px-6 py-10 space-y-12">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Design System</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Style guide — visible only when <code className="text-xs bg-muted px-1 rounded">DEMO_MODE=true</code>
            </p>
          </div>
          <ThemeToggle />
        </div>

        {/* Accent tokens */}
        <Section title="Accent Colour Tokens">
          <div className="space-y-2">
            <AccentSwatch
              label="--accent-brand (light: oklch 0.50 0.18 255)"
              bg="--accent-brand"
              fg="--accent-brand-foreground"
              ratio="text 13.28:1 ✓ | bg/white 12.04:1 ✓"
            />
            <p className="text-xs text-muted-foreground">
              Dark mode switches to oklch(0.75 0.15 255) — text on dark bg 4.77:1 ✓
            </p>
          </div>
        </Section>

        {/* Buttons */}
        <Section title="Buttons — all variants">
          <div className="flex flex-wrap gap-3">
            <Button variant="default">Default</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="link">Link</Button>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button size="xs">XS</Button>
            <Button size="sm">SM</Button>
            <Button size="default">Default size</Button>
            <Button size="lg">LG</Button>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button disabled>Disabled</Button>
            <Button
              style={{
                background: "var(--accent-brand)",
                color: "var(--accent-brand-foreground)",
              }}
            >
              Accent Brand
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Press any button — you should feel the <code>active:scale-[0.97]</code> feedback.
          </p>
        </Section>

        {/* Cards */}
        <Section title="Cards — hover to see ring deepen">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Card title</CardTitle>
                <CardDescription>Supporting description text</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  Card body content. Hover to see the ring transition.
                </p>
              </CardContent>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardTitle>Small card</CardTitle>
                <CardAction>
                  <Badge variant="secondary">New</Badge>
                </CardAction>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">Compact variant.</p>
              </CardContent>
              <CardFooter>
                <Button size="sm" variant="outline">Action</Button>
              </CardFooter>
            </Card>
          </div>
        </Section>

        {/* Badges */}
        <Section title="Badges">
          <div className="flex flex-wrap gap-2">
            <Badge variant="default">Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="destructive">Destructive</Badge>
            <Badge variant="ghost">Ghost</Badge>
            <Badge variant="link">Link</Badge>
            <Badge
              style={{
                background: "var(--accent-brand)",
                color: "var(--accent-brand-foreground)",
              }}
            >
              Accent
            </Badge>
          </div>
        </Section>

        {/* Skeletons */}
        <Section title="Skeletons — shimmer variant (default) + pulse">
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground mb-1">Shimmer (default)</p>
            <Skeleton className="h-8 w-full" shimmer />
            <Skeleton className="h-8 w-3/4" shimmer />
            <Skeleton className="h-8 w-1/2" shimmer />
          </div>
          <div className="space-y-3 mt-4">
            <p className="text-xs text-muted-foreground mb-1">Pulse (shimmer=false)</p>
            <Skeleton className="h-8 w-full" shimmer={false} />
            <Skeleton className="h-8 w-3/4" shimmer={false} />
          </div>
          <div className="space-y-2 mt-4">
            <p className="text-xs text-muted-foreground mb-1">Card skeleton</p>
            <Card>
              <CardHeader>
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-4 w-64 mt-1" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6 mt-2" />
                <Skeleton className="h-4 w-4/6 mt-2" />
              </CardContent>
            </Card>
          </div>
        </Section>

        {/* Toasts */}
        <Section title="Sonner Toasts — themed to our tokens">
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => toast.success("Milestone approved and payout triggered.")}
            >
              Success toast
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => toast.error("Funded milestone cannot be rescheduled.")}
            >
              Error toast
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => toast.warning("Dependent milestones were not moved.")}
            >
              Warning toast
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => toast.info("Analysis running — this may take a few seconds.")}
            >
              Info toast
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                toast.promise(
                  new Promise((resolve) => setTimeout(resolve, 2000)),
                  {
                    loading: "Processing payout…",
                    success: "Payout sent successfully.",
                    error: "Payout failed.",
                  }
                )
              }
            >
              Promise toast
            </Button>
          </div>
        </Section>

        {/* Drawer */}
        <Section title="Drawer — Vaul bottom sheet (approval card pattern)">
          <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
            <DrawerTrigger asChild>
              <Button>Open approval drawer</Button>
            </DrawerTrigger>
            <DrawerContent>
              <DrawerHeader>
                <DrawerTitle>Approve payout — Milestone 1</DrawerTitle>
                <DrawerDescription>
                  Review the evidence and approve or reject this payout request.
                </DrawerDescription>
              </DrawerHeader>
              <div className="px-6 py-4 space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Gross</span>
                  <span className="font-medium">$500.00</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Platform fee</span>
                  <span className="font-medium text-muted-foreground">−$6.55</span>
                </div>
                <div className="flex justify-between text-sm border-t pt-2">
                  <span className="font-medium">Payout to consultant</span>
                  <span className="font-semibold">$493.45</span>
                </div>
                <div
                  className="rounded-lg p-3 text-sm"
                  style={{
                    background: "color-mix(in oklch, var(--accent-brand) 12%, var(--background))",
                    color: "var(--foreground)",
                    border: "1px solid color-mix(in oklch, var(--accent-brand) 30%, transparent)",
                  }}
                >
                  All 3 acceptance criteria verified. Confidence: 94%.
                </div>
              </div>
              <DrawerFooter>
                <Button
                  style={{
                    background: "var(--accent-brand)",
                    color: "var(--accent-brand-foreground)",
                  }}
                  onClick={() => {
                    setDrawerOpen(false);
                    toast.success("Payout approved — sending to consultant.");
                  }}
                >
                  Approve payout
                </Button>
                <DrawerClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DrawerClose>
              </DrawerFooter>
            </DrawerContent>
          </Drawer>
          <p className="text-xs text-muted-foreground mt-2">
            Drag the handle or press Escape to close. Uses Vaul 1.1.2 (peer range includes React 19).
          </p>
        </Section>

        {/* Typography */}
        <Section title="Typography scale">
          <div className="space-y-2">
            <p className="text-2xl font-bold">Heading 2xl — font-bold</p>
            <p className="text-xl font-semibold">Heading xl — font-semibold</p>
            <p className="text-lg font-medium">Heading lg — font-medium</p>
            <p className="text-base">Body base — default weight</p>
            <p className="text-sm">Body sm — text-sm</p>
            <p className="text-xs text-muted-foreground">Caption xs — muted foreground</p>
            <p className="text-sm">
              Inline{" "}
              <span style={{ color: "var(--accent-brand)" }} className="font-medium">
                accent text (13.28:1 on light bg)
              </span>{" "}
              mid-sentence.
            </p>
          </div>
        </Section>

        {/* Spacing & radius */}
        <Section title="Radius scale">
          <div className="flex flex-wrap gap-3">
            {[
              { label: "sm", cls: "rounded-sm" },
              { label: "md", cls: "rounded-md" },
              { label: "lg (--radius)", cls: "rounded-lg" },
              { label: "xl", cls: "rounded-xl" },
              { label: "2xl", cls: "rounded-2xl" },
              { label: "full", cls: "rounded-full" },
            ].map(({ label, cls }) => (
              <div
                key={label}
                className={`${cls} border bg-muted px-4 py-2 text-xs font-mono text-muted-foreground`}
              >
                {label}
              </div>
            ))}
          </div>
        </Section>

      </div>
    </div>
  );
}
