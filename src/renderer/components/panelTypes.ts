import type { InjectionKey, Ref } from 'vue'

export type PanelDirection = 'horizontal' | 'vertical'

export interface PanelConstraints {
  minSize: number // percentage
  maxSize: number // percentage
  defaultSize: number // percentage
  collapsible: boolean
  collapsedSize: number // percentage
  minSizePx?: number // pixel-based minimum, takes precedence over percentage when larger
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
