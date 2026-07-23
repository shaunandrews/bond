import type { InjectionKey, Ref } from 'vue'

export type PanelDirection = 'horizontal' | 'vertical'
export type PanelUnit = 'px' | '%'

export interface PanelConstraints {
  minSize: number // in unit
  maxSize: number // in unit
  defaultSize: number // in unit
  collapsible: boolean
  collapsedSize: number // in unit
  unit: PanelUnit
  minSizePx?: number // pixel-based minimum — takes precedence for flex panels during resize
}

export interface PanelRegistration {
  id: string
  constraints: PanelConstraints
  // Only consulted the first time this id is registered (a fresh mount) — an
  // external boolean the panel should honor as its starting collapse state,
  // overriding whatever the group's own persisted collapse set says for this
  // id. Lets a consumer keep one source of truth (its own persisted "is this
  // panel open" flag) instead of reconciling it against the group's cache.
  initialCollapsed?: boolean
}

export interface PanelGroupContext {
  direction: Ref<PanelDirection>
  registerPanel: (reg: PanelRegistration) => void
  unregisterPanel: (id: string) => void
  getPanelSize: (id: string) => number
  getPanelUnit: (id: string) => PanelUnit
  getFlexStyle: (id: string) => string
  getMinDimStyle: (id: string) => string
  getPanelIds: () => string[]
  startResize: (beforePanelId: string, afterPanelId: string) => void
  moveResize: (delta: number) => void
  endResize: () => void
  keyboardResize: (beforePanelId: string, afterPanelId: string, delta: number) => void
  collapsePanel: (id: string) => void
  expandPanel: (id: string) => void
  isPanelCollapsed: (id: string) => boolean
  resizePanel: (id: string, size: number) => void
}

export const PANEL_GROUP_KEY: InjectionKey<PanelGroupContext> = Symbol('BondPanelGroup')
