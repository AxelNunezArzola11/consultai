/**
 * Motion presets for ConsultAI.
 *
 * Rules:
 * - Springs only for state transitions; duration-based only for micro-interactions.
 * - Animate transform and opacity only — no layout animations (width/height/position).
 * - Never animate from scale 0; start near 0.96 with opacity 0.
 * - Press feedback: active:scale-[0.97] via CSS (no JS needed).
 * - Honour prefers-reduced-motion: call shouldAnimate() before any JS-driven animation.
 * - No layout animation inside AG Grid or Bryntum Gantt.
 */

import { useReducedMotion } from "framer-motion";

// ---------------------------------------------------------------------------
// Spring configs (framer-motion Transition objects)
// ---------------------------------------------------------------------------

/** Snappy spring for UI state changes (modals, drawers, popovers). */
export const springStiff = {
  type: "spring" as const,
  stiffness: 400,
  damping: 30,
  mass: 0.8,
};

/** Gentle spring for content entering the page (cards, panels). */
export const springGentle = {
  type: "spring" as const,
  stiffness: 260,
  damping: 24,
  mass: 0.9,
};

/** Micro spring for tiny interactions (icon bounce, badge pop). */
export const springMicro = {
  type: "spring" as const,
  stiffness: 500,
  damping: 35,
  mass: 0.6,
};

// ---------------------------------------------------------------------------
// Shared variants
// ---------------------------------------------------------------------------

/** Enter from slightly below with fade — use for cards/panels appearing. */
export const fadeSlideUp = {
  initial: { opacity: 0, y: 8, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 4, scale: 0.98 },
  transition: springGentle,
};

/** Scale-in from near-1 — use for drawers and dialogs. */
export const scaleIn = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.97 },
  transition: springStiff,
};

/** Simple opacity fade — lightest touch; use for overlays. */
export const fadeIn = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.15 },
};

/** Stagger children — wrap a list in a motion.div with this. */
export const staggerContainer = {
  initial: {},
  animate: { transition: { staggerChildren: 0.06 } },
};

/** Individual stagger child — pair with staggerContainer. */
export const staggerItem = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: springGentle },
};

// ---------------------------------------------------------------------------
// shouldAnimate() — always call this before starting a JS-driven animation
// ---------------------------------------------------------------------------

/**
 * Returns false when the user has requested reduced motion in their OS settings.
 * Call this in every component that drives animations from JS/framer-motion.
 *
 * Usage (React component):
 *   const animate = useShouldAnimate();
 *   <motion.div animate={animate ? { opacity: 1, y: 0 } : { opacity: 1 }} />
 *
 * For CSS-only transitions/animations, the @media (prefers-reduced-motion: reduce)
 * block in globals.css handles suppression automatically — no JS needed.
 */
export function useShouldAnimate(): boolean {
  const prefersReduced = useReducedMotion();
  return !prefersReduced;
}
