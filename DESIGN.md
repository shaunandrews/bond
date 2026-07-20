---
colors:
  bg: "#f6f5f2"
  surface: "#ffffff"
  border: "#ddd9d0"
  text-primary: "#1a1c1f"
  muted: "#5c6570"
  accent: "#7a5c3b"
  err: "#e57373"
  ok: "#81c784"
  on-accent: "#ffffff"
  focus: "#1e5aa8"
  error-text: "#a33737"
  success-text: "#2d6a3a"
typography:
  caption: "0.75rem"
  label: "0.875rem"
  body: "1rem"
  title: "1.25rem"
  heading: "1.5rem"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
spacing:
  tight: "0.25rem"
  compact: "0.5rem"
  default: "0.75rem"
  roomy: "1rem"
  section: "1.5rem"
---

# Bond Design System

## North star
**The quiet command desk.** Bond is calm, compact, local, and serious. Density, hierarchy, and direct manipulation beat decoration.

The warm paper-desk palette is intentional product character, not a restriction. Simplify or extend it when the product needs it; preserve semantic contrast and hierarchy.

## Color and contrast
Use semantic CSS variables, never raw color literals in components. Accent is reserved for a primary action, current selection, or meaningful state.

`--color-accent` may be personalized. Its paired `--color-on-accent` must always be contrast-safe. Add and use `--color-focus`, `--color-error-text`, and `--color-success-text` for readable foreground roles; `accent`, `err`, and `ok` are not universal text colors.

Body text and placeholders require 4.5:1 contrast. Large text requires 3:1.

## Type and reading measure
Use the fixed product scale: 12px caption, 14px label, 16px body, 20px title, 24px heading. Use mono only for identifiers, paths, code, timestamps needing alignment, and collection references.

A surface gets one title and one primary action. Do not manufacture hierarchy with uppercase eyebrow labels. Constrain prose values and comments to `--measure-prose: 70ch` (never beyond 80ch).

## Spacing, elevation, and layers
Use `--space-tight` (4px), `--space-compact` (8px), `--space-default` (12px), `--space-roomy` (16px), and `--space-section` (24px).

Surfaces separate through canvas, border, and spacing. Shadows belong only to floating flyouts, dialogs, tooltips, and transient overlays. Do not stack shadows or nest cards.

Use the layer ladder: sticky 10, dropdown 50, modal backdrop 100, modal 110, toast 120, tooltip 130. Literal z-index values and `9999` are prohibited.

## Motion and focus
Use 150ms fast, 200ms standard, and 150ms exit durations with `cubic-bezier(0.16, 1, 0.3, 1)`. Animate opacity and transform only; do not animate layout properties. Respect `prefers-reduced-motion` by removing nonessential animation.

Every interactive primitive supplies default, hover, focus-visible, active, disabled, loading, and error states. `:focus-visible` is a 2px focus outline with 2px offset. Mouse interaction never suppresses keyboard focus.

## Components
Use `BondButton`, `BondInput`, `BondTextarea`, `BondSelect`, `BondFlyoutMenu`, `BondTab`, `BondToolbar`, and `ViewShell` before adding new UI. Extend a primitive when a behavior is broadly reusable; do not create a one-screen imitation.

## Collection table contract
Table header and rows share one CSS grid template: `minmax(14rem, 2fr)` primary column, `minmax(9rem, 1fr)` data columns, and `2rem` actions. The grid lives in one horizontal overflow viewport. Below a 40rem container, default to list view.

Keep state, boolean, and action tracks narrow; give the primary title the flexible track. Truncate single-line cells; item detail owns long content. Table headers and rows must be keyboard-operable, with sortable headers exposing `aria-sort`.

## Do and do not
Do use restrained color, compact desktop density, stable toolbars, semantic tokens, and familiar controls.

Do not use novelty-chatbot aesthetics, opaque-agent theatrics, Airtable-clone styling, generic card grids, colored side stripes, gradient text, nested cards, or dashboard sprawl.
