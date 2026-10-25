# ConsultAI Design System

This document outlines the visual identity, component behavior, and UI/UX standards for the ConsultAI platform.

## 1. Color Palette (Dark Theme First)
- **Backgrounds:** 
  - Main App Background: `bg-slate-950`
  - Cards, Panels, and Modals: `bg-slate-900`
  - Subtle Sections/Separators: `bg-slate-800`
- **Accents & Brand:**
  - Primary Action (Buttons, active tabs): `bg-blue-600`
  - Primary Hover: `hover:bg-blue-500`
  - Success (Passed Scores): `text-emerald-400`, `bg-emerald-400/10`
  - Warning/Failed: `text-amber-500`, `bg-amber-500/10`
- **Typography:**
  - Primary Text: `text-slate-100`
  - Secondary/Muted Text: `text-slate-400`

## 2. Shapes & Shadows
- **Border Radius:** Use heavily rounded corners for floating elements and cards. Standard is `rounded-2xl` for main cards and `rounded-full` for pill buttons/badges.
- **Borders:** Subtle borders are required to separate elements in dark mode. Use `border border-slate-800`.
- **Shadows:** Floating elements (like the chat widget or dropdowns) must use deep shadows to create depth: `shadow-2xl shadow-black/50`.

## 3. UI Components & Interaction
- **Buttons:** Must always include transition effects (`transition-colors duration-200`) and accessible focus states (`focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950`).
- **Animations:** Use `framer-motion` for smooth layout transitions (e.g., expanding the Trust Score card) and Tailwind's `animate-pulse` for loading states (e.g., awaiting payment, AI thinking).

## 4. AI Assistant Widget (Chat) Specifications
- **Floating UI:** The chat container must appear detached from the background using the shadows and borders defined above.
- **Markdown Support:** All chat messages from the AI must be rendered using `react-markdown` and `remark-gfm` to support bold text, lists, and tables.
- **Code Blocks:** Code snippets inside the chat must have a distinct background (`bg-slate-950`), padding (`p-4`), and rounded corners (`rounded-lg`).
- **Status Indicators:** When the AI is processing, display a minimal, animated loading indicator (e.g., 3 pulsing dots).