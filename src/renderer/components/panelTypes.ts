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
  startResize: (handleId: string) => void
  moveResize: (delta: number) => void
  endResize: () => void
  keyboardResize: (handleId: string, delta: number) => void
  collapsePanel: (id: string) => void
  expandPanel: (id: string) => void
  isPanelCollapsed: (id: string) => boolean
  resizePanel: (id: string, size: number) => void
  getHandlePanels: (handleId: string) => { before: string; after: string } | null
}

export const PANEL_GROUP_KEY: InjectionKey<PanelGroupContext> = Symbol('BondPanelGroup')
