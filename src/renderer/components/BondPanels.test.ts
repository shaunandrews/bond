import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, defineComponent, ref } from 'vue'
import BondPanelGroup from './BondPanelGroup.vue'
import BondPanel from './BondPanel.vue'
import BondPanelHandle from './BondPanelHandle.vue'

// Flush rAF-based panel animations by fast-forwarding performance.now()
async function flushPanelAnimation() {
  const original = performance.now.bind(performance)
  const start = original()
  vi.spyOn(performance, 'now').mockReturnValue(start + 200)
  await new Promise((r) => requestAnimationFrame(r))
  await nextTick()
  vi.restoreAllMocks()
}

/** Extract flex-grow value from a panel's inline style */
function getFlexGrow(style: string): number {
  const match = style.match(/flex-grow:\s*([\d.]+)/)
  return match ? parseFloat(match[1]) : NaN
}

/** Extract flex-basis pixel value from a panel's inline style (for px-unit panels) */
function getFlexBasisPx(style: string): number {
  const match = style.match(/flex-basis:\s*([\d.]+)px/)
  return match ? parseFloat(match[1]) : NaN
}

// Helper: mount a basic two-panel horizontal layout
function mountTwoPanels(opts: {
  direction?: 'horizontal' | 'vertical'
  panel1?: Record<string, unknown>
  panel2?: Record<string, unknown>
  autoSaveId?: string
} = {}) {
  const { direction = 'horizontal', panel1 = {}, panel2 = {}, autoSaveId } = opts

  return mount(
    defineComponent({
      components: { BondPanelGroup, BondPanel, BondPanelHandle },
      template: `
        <BondPanelGroup :direction="direction" :autoSaveId="autoSaveId">
          <BondPanel id="left" v-bind="panel1">
            <div>Left</div>
          </BondPanel>
          <BondPanelHandle id="handle-0" />
          <BondPanel id="right" v-bind="panel2">
            <div>Right</div>
          </BondPanel>
        </BondPanelGroup>
      `,
      setup() {
        return { direction, panel1, panel2, autoSaveId }
      },
    }),
    { attachTo: document.body },
  )
}

// Helper: mount three-panel layout
function mountThreePanels(opts: {
  direction?: 'horizontal' | 'vertical'
  panel1?: Record<string, unknown>
  panel2?: Record<string, unknown>
  panel3?: Record<string, unknown>
} = {}) {
  const { direction = 'horizontal', panel1 = {}, panel2 = {}, panel3 = {} } = opts

  return mount(
    defineComponent({
      components: { BondPanelGroup, BondPanel, BondPanelHandle },
      template: `
        <BondPanelGroup :direction="direction">
          <BondPanel id="a" v-bind="panel1"><div>A</div></BondPanel>
          <BondPanelHandle id="handle-0" />
          <BondPanel id="b" v-bind="panel2"><div>B</div></BondPanel>
          <BondPanelHandle id="handle-1" />
          <BondPanel id="c" v-bind="panel3"><div>C</div></BondPanel>
        </BondPanelGroup>
      `,
      setup() {
        return { direction, panel1, panel2, panel3 }
      },
    }),
    { attachTo: document.body },
  )
}

describe('BondPanelGroup', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe('rendering', () => {
    it('renders with correct direction class', () => {
      const w = mountTwoPanels({ direction: 'horizontal' })
      expect(w.find('.bond-panel-group--horizontal').exists()).toBe(true)
      w.unmount()
    })

    it('renders vertical direction', () => {
      const w = mountTwoPanels({ direction: 'vertical' })
      expect(w.find('.bond-panel-group--vertical').exists()).toBe(true)
      w.unmount()
    })

    it('sets data-direction attribute', () => {
      const w = mountTwoPanels({ direction: 'horizontal' })
      expect(w.find('[data-direction="horizontal"]').exists()).toBe(true)
      w.unmount()
    })

    it('renders panels as children', () => {
      const w = mountTwoPanels()
      const panels = w.findAll('.bond-panel')
      expect(panels).toHaveLength(2)
      w.unmount()
    })

    it('renders handle between panels', () => {
      const w = mountTwoPanels()
      expect(w.find('.bond-panel-handle').exists()).toBe(true)
      w.unmount()
    })
  })

  describe('default sizing', () => {
    it('distributes equal defaults when both panels have defaultSize=50', async () => {
      const w = mountTwoPanels({
        panel1: { defaultSize: 50 },
        panel2: { defaultSize: 50 },
      })
      await nextTick()

      const panels = w.findAll('.bond-panel')
      expect(getFlexGrow(panels[0].attributes('style') ?? '')).toBe(50)
      expect(getFlexGrow(panels[1].attributes('style') ?? '')).toBe(50)
      w.unmount()
    })

    it('distributes proportional defaults (30/70)', async () => {
      const w = mountTwoPanels({
        panel1: { defaultSize: 30 },
        panel2: { defaultSize: 70 },
      })
      await nextTick()

      const panels = w.findAll('.bond-panel')
      expect(getFlexGrow(panels[0].attributes('style') ?? '')).toBe(30)
      expect(getFlexGrow(panels[1].attributes('style') ?? '')).toBe(70)
      w.unmount()
    })

    it('normalizes defaults that do not sum to 100', async () => {
      const w = mountTwoPanels({
        panel1: { defaultSize: 1 },
        panel2: { defaultSize: 3 },
      })
      await nextTick()

      const panels = w.findAll('.bond-panel')
      expect(getFlexGrow(panels[0].attributes('style') ?? '')).toBe(25)
      expect(getFlexGrow(panels[1].attributes('style') ?? '')).toBe(75)
      w.unmount()
    })

    it('three panels get equal defaults', async () => {
      const w = mountThreePanels({
        panel1: { defaultSize: 33.33 },
        panel2: { defaultSize: 33.33 },
        panel3: { defaultSize: 33.34 },
      })
      await nextTick()

      const panels = w.findAll('.bond-panel')
      expect(panels).toHaveLength(3)
      for (const p of panels) {
        const val = getFlexGrow(p.attributes('style') ?? '')
        expect(val).toBeGreaterThan(30)
        expect(val).toBeLessThan(40)
      }
      w.unmount()
    })
  })

  describe('panel data attributes', () => {
    it('sets data-panel-id on each panel', () => {
      const w = mountTwoPanels()
      expect(w.find('[data-panel-id="left"]').exists()).toBe(true)
      expect(w.find('[data-panel-id="right"]').exists()).toBe(true)
      w.unmount()
    })

    it('sets data-state="expanded" by default', () => {
      const w = mountTwoPanels()
      const panels = w.findAll('.bond-panel')
      expect(panels[0].attributes('data-state')).toBe('expanded')
      expect(panels[1].attributes('data-state')).toBe('expanded')
      w.unmount()
    })
  })

  describe('handle accessibility', () => {
    it('has role="separator"', () => {
      const w = mountTwoPanels()
      const handle = w.find('.bond-panel-handle')
      expect(handle.attributes('role')).toBe('separator')
      w.unmount()
    })

    it('has tabindex=0 when not disabled', () => {
      const w = mountTwoPanels()
      const handle = w.find('.bond-panel-handle')
      expect(handle.attributes('tabindex')).toBe('0')
      w.unmount()
    })

    it('has aria-orientation perpendicular to group direction', () => {
      const h = mountTwoPanels({ direction: 'horizontal' })
      expect(h.find('.bond-panel-handle').attributes('aria-orientation')).toBe('vertical')
      h.unmount()

      const v = mountTwoPanels({ direction: 'vertical' })
      expect(v.find('.bond-panel-handle').attributes('aria-orientation')).toBe('horizontal')
      v.unmount()
    })

    it('has data-state="inactive" by default', () => {
      const w = mountTwoPanels()
      expect(w.find('.bond-panel-handle').attributes('data-state')).toBe('inactive')
      w.unmount()
    })
  })

  describe('handle hover state', () => {
    it('sets data-state to hover on mouseenter', async () => {
      const w = mountTwoPanels()
      const handle = w.find('.bond-panel-handle')
      await handle.trigger('mouseenter')
      expect(handle.attributes('data-state')).toBe('hover')
      w.unmount()
    })

    it('resets data-state on mouseleave', async () => {
      const w = mountTwoPanels()
      const handle = w.find('.bond-panel-handle')
      await handle.trigger('mouseenter')
      await handle.trigger('mouseleave')
      expect(handle.attributes('data-state')).toBe('inactive')
      w.unmount()
    })
  })

  describe('disabled handle', () => {
    it('sets tabindex=-1 and aria-disabled when disabled', () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="horizontal">
              <BondPanel id="a" :defaultSize="50"><div>A</div></BondPanel>
              <BondPanelHandle id="handle-0" disabled />
              <BondPanel id="b" :defaultSize="50"><div>B</div></BondPanel>
            </BondPanelGroup>
          `,
        }),
        { attachTo: document.body },
      )
      const handle = w.find('.bond-panel-handle')
      expect(handle.attributes('tabindex')).toBe('-1')
      expect(handle.attributes('aria-disabled')).toBe('true')
      expect(handle.classes()).toContain('bond-panel-handle--disabled')
      w.unmount()
    })
  })

  describe('keyboard resize', () => {
    it('resizes panels on ArrowRight in horizontal mode', async () => {
      const w = mountTwoPanels({
        direction: 'horizontal',
        panel1: { defaultSize: 50 },
        panel2: { defaultSize: 50 },
      })
      await nextTick()

      const handle = w.find('.bond-panel-handle')
      await handle.trigger('keydown', { key: 'ArrowRight' })
      await nextTick()

      const panels = w.findAll('.bond-panel')
      expect(getFlexGrow(panels[0].attributes('style') ?? '')).toBe(55)
      expect(getFlexGrow(panels[1].attributes('style') ?? '')).toBe(45)
      w.unmount()
    })

    it('resizes panels on ArrowLeft in horizontal mode', async () => {
      const w = mountTwoPanels({
        direction: 'horizontal',
        panel1: { defaultSize: 50 },
        panel2: { defaultSize: 50 },
      })
      await nextTick()

      const handle = w.find('.bond-panel-handle')
      await handle.trigger('keydown', { key: 'ArrowLeft' })
      await nextTick()

      const panels = w.findAll('.bond-panel')
      expect(getFlexGrow(panels[0].attributes('style') ?? '')).toBe(45)
      w.unmount()
    })

    it('resizes panels on ArrowDown in vertical mode', async () => {
      const w = mountTwoPanels({
        direction: 'vertical',
        panel1: { defaultSize: 50 },
        panel2: { defaultSize: 50 },
      })
      await nextTick()

      const handle = w.find('.bond-panel-handle')
      await handle.trigger('keydown', { key: 'ArrowDown' })
      await nextTick()

      const panels = w.findAll('.bond-panel')
      expect(getFlexGrow(panels[0].attributes('style') ?? '')).toBe(55)
      w.unmount()
    })

    it('respects minSize constraints during keyboard resize', async () => {
      const w = mountTwoPanels({
        panel1: { defaultSize: 15, minSize: 10 },
        panel2: { defaultSize: 85, minSize: 10 },
      })
      await nextTick()

      const handle = w.find('.bond-panel-handle')
      // Try to shrink left panel below minSize
      await handle.trigger('keydown', { key: 'ArrowLeft' })
      await nextTick()

      const panels = w.findAll('.bond-panel')
      expect(getFlexGrow(panels[0].attributes('style') ?? '')).toBeGreaterThanOrEqual(10)
      w.unmount()
    })

    it('does not respond to arrow keys when disabled', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="horizontal">
              <BondPanel id="a" :defaultSize="50"><div>A</div></BondPanel>
              <BondPanelHandle id="handle-0" disabled />
              <BondPanel id="b" :defaultSize="50"><div>B</div></BondPanel>
            </BondPanelGroup>
          `,
        }),
        { attachTo: document.body },
      )
      await nextTick()

      const handle = w.find('.bond-panel-handle')
      await handle.trigger('keydown', { key: 'ArrowRight' })
      await nextTick()

      const panels = w.findAll('.bond-panel')
      expect(getFlexGrow(panels[0].attributes('style') ?? '')).toBe(50)
      w.unmount()
    })
  })

  describe('collapsible panels', () => {
    it('panel can be collapsed via imperative API', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="horizontal">
              <BondPanel id="left" ref="leftPanel" :defaultSize="30" :minSize="15" collapsible :collapsedSize="0">
                <div>Left</div>
              </BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="right" :defaultSize="70">
                <div>Right</div>
              </BondPanel>
            </BondPanelGroup>
          `,
          setup() {
            const leftPanel = ref()
            return { leftPanel }
          },
        }),
        { attachTo: document.body },
      )
      await nextTick()

      const leftPanel = w.vm.leftPanel
      leftPanel.collapse()
      await flushPanelAnimation()

      const panels = w.findAll('.bond-panel')
      expect(panels[0].attributes('data-state')).toBe('collapsed')
      expect(getFlexGrow(panels[0].attributes('style') ?? '')).toBe(0)

      // Right panel should absorb the freed space
      expect(getFlexGrow(panels[1].attributes('style') ?? '')).toBe(100)
      w.unmount()
    })

    it('panel can be expanded after collapse', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="horizontal">
              <BondPanel id="left" ref="leftPanel" :defaultSize="30" :minSize="15" collapsible :collapsedSize="0">
                <div>Left</div>
              </BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="right" :defaultSize="70" :minSize="20">
                <div>Right</div>
              </BondPanel>
            </BondPanelGroup>
          `,
          setup() {
            const leftPanel = ref()
            return { leftPanel }
          },
        }),
        { attachTo: document.body },
      )
      await nextTick()

      const leftPanel = w.vm.leftPanel
      leftPanel.collapse()
      await flushPanelAnimation()

      leftPanel.expand()
      await flushPanelAnimation()

      const panels = w.findAll('.bond-panel')
      expect(panels[0].attributes('data-state')).toBe('expanded')
      // Should restore to original 30
      expect(getFlexGrow(panels[0].attributes('style') ?? '')).toBe(30)
      w.unmount()
    })
  })

  describe('imperative resize', () => {
    it('resizes a panel via imperative API', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="horizontal">
              <BondPanel id="left" ref="leftPanel" :defaultSize="50" :minSize="10" :maxSize="80">
                <div>Left</div>
              </BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="right" :defaultSize="50" :minSize="10">
                <div>Right</div>
              </BondPanel>
            </BondPanelGroup>
          `,
          setup() {
            const leftPanel = ref()
            return { leftPanel }
          },
        }),
        { attachTo: document.body },
      )
      await nextTick()

      w.vm.leftPanel.resize(70)
      await nextTick()

      const panels = w.findAll('.bond-panel')
      expect(getFlexGrow(panels[0].attributes('style') ?? '')).toBe(70)
      expect(getFlexGrow(panels[1].attributes('style') ?? '')).toBe(30)
      w.unmount()
    })

    it('clamps to maxSize during imperative resize', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="horizontal">
              <BondPanel id="left" ref="leftPanel" :defaultSize="50" :minSize="10" :maxSize="60">
                <div>Left</div>
              </BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="right" :defaultSize="50" :minSize="10">
                <div>Right</div>
              </BondPanel>
            </BondPanelGroup>
          `,
          setup() {
            const leftPanel = ref()
            return { leftPanel }
          },
        }),
        { attachTo: document.body },
      )
      await nextTick()

      w.vm.leftPanel.resize(90)
      await nextTick()

      const panels = w.findAll('.bond-panel')
      expect(getFlexGrow(panels[0].attributes('style') ?? '')).toBe(60)
      w.unmount()
    })

    it('getSize returns current size', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="horizontal">
              <BondPanel id="left" ref="leftPanel" :defaultSize="40">
                <div>Left</div>
              </BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="right" :defaultSize="60">
                <div>Right</div>
              </BondPanel>
            </BondPanelGroup>
          `,
          setup() {
            const leftPanel = ref()
            return { leftPanel }
          },
        }),
        { attachTo: document.body },
      )
      await nextTick()

      expect(w.vm.leftPanel.getSize()).toBe(40)
      w.unmount()
    })

    it('isCollapsed returns false by default', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="horizontal">
              <BondPanel id="left" ref="leftPanel" :defaultSize="50" collapsible>
                <div>Left</div>
              </BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="right" :defaultSize="50">
                <div>Right</div>
              </BondPanel>
            </BondPanelGroup>
          `,
          setup() {
            const leftPanel = ref()
            return { leftPanel }
          },
        }),
        { attachTo: document.body },
      )
      await nextTick()

      expect(w.vm.leftPanel.isCollapsed()).toBe(false)
      w.unmount()
    })
  })

  describe('persistence', () => {
    it('saves layout to localStorage when autoSaveId is set', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="horizontal" autoSaveId="test-layout">
              <BondPanel id="left" ref="leftPanel" :defaultSize="50" :minSize="10">
                <div>Left</div>
              </BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="right" :defaultSize="50" :minSize="10">
                <div>Right</div>
              </BondPanel>
            </BondPanelGroup>
          `,
          setup() {
            const leftPanel = ref()
            return { leftPanel }
          },
        }),
        { attachTo: document.body },
      )
      await nextTick()

      // Trigger a keyboard resize which saves
      const handle = w.find('.bond-panel-handle')
      await handle.trigger('keydown', { key: 'ArrowRight' })
      await nextTick()

      const stored = localStorage.getItem('bond:panels:test-layout')
      expect(stored).not.toBeNull()
      const parsed = JSON.parse(stored!)
      expect(parsed.sizes.left).toBe(55)
      expect(parsed.sizes.right).toBe(45)
      expect(parsed.units.left).toBe('%')
      expect(parsed.units.right).toBe('%')
      w.unmount()
    })

    it('restores layout from localStorage on mount', async () => {
      // Pre-set a saved layout
      localStorage.setItem(
        'bond:panels:restore-test',
        JSON.stringify({ sizes: { left: 25, right: 75 }, units: { left: '%', right: '%' }, collapsed: [] }),
      )

      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="horizontal" autoSaveId="restore-test">
              <BondPanel id="left" :defaultSize="50">
                <div>Left</div>
              </BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="right" :defaultSize="50">
                <div>Right</div>
              </BondPanel>
            </BondPanelGroup>
          `,
        }),
        { attachTo: document.body },
      )
      await nextTick()

      const panels = w.findAll('.bond-panel')
      expect(getFlexGrow(panels[0].attributes('style') ?? '')).toBe(25)
      expect(getFlexGrow(panels[1].attributes('style') ?? '')).toBe(75)
      w.unmount()
    })

    it('ignores saved layout if panel ids do not match', async () => {
      localStorage.setItem(
        'bond:panels:stale-test',
        JSON.stringify({ sizes: { old: 25, other: 75 }, collapsed: [] }),
      )

      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="horizontal" autoSaveId="stale-test">
              <BondPanel id="left" :defaultSize="40">
                <div>Left</div>
              </BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="right" :defaultSize="60">
                <div>Right</div>
              </BondPanel>
            </BondPanelGroup>
          `,
        }),
        { attachTo: document.body },
      )
      await nextTick()

      const panels = w.findAll('.bond-panel')
      expect(getFlexGrow(panels[0].attributes('style') ?? '')).toBe(40)
      w.unmount()
    })

    it('discards saved layout when panel unit changes', async () => {
      // Saved with percentage unit
      localStorage.setItem(
        'bond:panels:unit-change-test',
        JSON.stringify({ sizes: { left: 20, right: 80 }, units: { left: '%', right: '%' }, collapsed: [] }),
      )

      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="horizontal" autoSaveId="unit-change-test">
              <BondPanel id="left" unit="px" :defaultSize="260" :minSize="220" :maxSize="400">
                <div>Left</div>
              </BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="right" :defaultSize="80">
                <div>Right</div>
              </BondPanel>
            </BondPanelGroup>
          `,
        }),
        { attachTo: document.body },
      )
      await nextTick()

      const panels = w.findAll('.bond-panel')
      // Should use defaults, not saved values
      expect(getFlexBasisPx(panels[0].attributes('style') ?? '')).toBe(260)
      w.unmount()
    })
  })

  describe('pixel-unit panels', () => {
    it('renders pixel panel with flex: 0 0 Npx', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="horizontal">
              <BondPanel id="sidebar" unit="px" :defaultSize="260" :minSize="220" :maxSize="400">
                <div>Sidebar</div>
              </BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="main" :defaultSize="80">
                <div>Main</div>
              </BondPanel>
            </BondPanelGroup>
          `,
        }),
        { attachTo: document.body },
      )
      await nextTick()

      const panels = w.findAll('.bond-panel')
      const sidebarStyle = panels[0].attributes('style') ?? ''
      expect(sidebarStyle).toContain('flex-grow: 0')
      expect(sidebarStyle).toContain('flex-shrink: 1')
      expect(getFlexBasisPx(sidebarStyle)).toBe(260)

      // Main panel should use flex-grow (normalized to 100 as the only % panel)
      expect(getFlexGrow(panels[1].attributes('style') ?? '')).toBe(100)
      w.unmount()
    })

    it('pixel panel collapse and expand works', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="horizontal">
              <BondPanel id="sidebar" ref="sidebarPanel" unit="px" :defaultSize="260" :minSize="220" :maxSize="400" collapsible :collapsedSize="0">
                <div>Sidebar</div>
              </BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="main" :defaultSize="80">
                <div>Main</div>
              </BondPanel>
            </BondPanelGroup>
          `,
          setup() {
            const sidebarPanel = ref()
            return { sidebarPanel }
          },
        }),
        { attachTo: document.body },
      )
      await nextTick()

      // Collapse
      w.vm.sidebarPanel.collapse()
      await flushPanelAnimation()

      const panels = w.findAll('.bond-panel')
      expect(panels[0].attributes('data-state')).toBe('collapsed')
      expect(getFlexBasisPx(panels[0].attributes('style') ?? '')).toBe(0)

      // Expand
      w.vm.sidebarPanel.expand()
      await flushPanelAnimation()

      expect(panels[0].attributes('data-state')).toBe('expanded')
      expect(getFlexBasisPx(panels[0].attributes('style') ?? '')).toBe(260)
      w.unmount()
    })
  })

  describe('group imperative API', () => {
    it('getLayout returns current sizes', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup ref="group" direction="horizontal">
              <BondPanel id="left" :defaultSize="30"><div>L</div></BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="right" :defaultSize="70"><div>R</div></BondPanel>
            </BondPanelGroup>
          `,
          setup() {
            const group = ref()
            return { group }
          },
        }),
        { attachTo: document.body },
      )
      await nextTick()

      const layout = w.vm.group.getLayout()
      expect(layout.left).toBe(30)
      expect(layout.right).toBe(70)
      w.unmount()
    })

    it('setLayout applies sizes', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup ref="group" direction="horizontal">
              <BondPanel id="left" :defaultSize="50"><div>L</div></BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="right" :defaultSize="50"><div>R</div></BondPanel>
            </BondPanelGroup>
          `,
          setup() {
            const group = ref()
            return { group }
          },
        }),
        { attachTo: document.body },
      )
      await nextTick()

      w.vm.group.setLayout({ left: 20, right: 80 })
      await nextTick()

      const panels = w.findAll('.bond-panel')
      expect(getFlexGrow(panels[0].attributes('style') ?? '')).toBe(20)
      w.unmount()
    })
  })

  describe('events', () => {
    it('emits layoutChange and layoutChanged on keyboard resize', async () => {
      const w = mountTwoPanels({
        panel1: { defaultSize: 50 },
        panel2: { defaultSize: 50 },
      })
      await nextTick()

      const handle = w.find('.bond-panel-handle')
      await handle.trigger('keydown', { key: 'ArrowRight' })
      await nextTick()

      const group = w.findComponent(BondPanelGroup)
      expect(group.emitted('layoutChange')).toBeTruthy()
      expect(group.emitted('layoutChanged')).toBeTruthy()
      w.unmount()
    })
  })

  describe('slot props', () => {
    it('passes size and collapsed to panel slot', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="horizontal">
              <BondPanel id="left" :defaultSize="40" collapsible>
                <template #default="{ size, collapsed }">
                  <div class="slot-output">{{ size }}-{{ collapsed }}</div>
                </template>
              </BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="right" :defaultSize="60">
                <div>Right</div>
              </BondPanel>
            </BondPanelGroup>
          `,
        }),
        { attachTo: document.body },
      )
      await nextTick()

      expect(w.find('.slot-output').text()).toBe('40-false')
      w.unmount()
    })
  })

  describe('nested groups', () => {
    it('supports a panel group nested inside a panel', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="horizontal">
              <BondPanel id="sidebar" :defaultSize="30"><div>Sidebar</div></BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="main" :defaultSize="70">
                <BondPanelGroup direction="vertical">
                  <BondPanel id="editor" :defaultSize="60"><div>Editor</div></BondPanel>
                  <BondPanelHandle id="handle-0" />
                  <BondPanel id="terminal" :defaultSize="40"><div>Terminal</div></BondPanel>
                </BondPanelGroup>
              </BondPanel>
            </BondPanelGroup>
          `,
        }),
        { attachTo: document.body },
      )
      await nextTick()

      // Outer group has 2 panels
      const outerPanels = w.findAll('[data-panel-id="sidebar"], [data-panel-id="main"]')
      expect(outerPanels).toHaveLength(2)

      // Inner group has 2 panels
      const innerPanels = w.findAll('[data-panel-id="editor"], [data-panel-id="terminal"]')
      expect(innerPanels).toHaveLength(2)

      // Outer and inner handles should both exist
      const handles = w.findAll('.bond-panel-handle')
      expect(handles).toHaveLength(2)
      w.unmount()
    })
  })

  describe('header prop', () => {
    it('renders a clickable header when header + collapsible are set', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="vertical">
              <BondPanel id="top" :defaultSize="50" header="Top" collapsible>
                <div>Content</div>
              </BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="bottom" :defaultSize="50">
                <div>Bottom</div>
              </BondPanel>
            </BondPanelGroup>
          `,
        }),
        { attachTo: document.body },
      )
      await nextTick()

      const header = w.find('.bond-panel__header')
      expect(header.exists()).toBe(true)
      expect(header.text()).toContain('Top')
      // Chevron should be present
      expect(w.find('.bond-panel__chevron').exists()).toBe(true)
      w.unmount()
    })

    it('clicking header toggles collapse', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="vertical">
              <BondPanel id="top" :defaultSize="50" header="Top" collapsible :collapsedSize="0">
                <div class="inner">Content</div>
              </BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="bottom" :defaultSize="50">
                <div>Bottom</div>
              </BondPanel>
            </BondPanelGroup>
          `,
        }),
        { attachTo: document.body },
      )
      await nextTick()

      const panel = w.find('[data-panel-id="top"]')
      expect(panel.attributes('data-state')).toBe('expanded')

      // Click header to collapse
      await w.find('.bond-panel__header').trigger('click')
      await nextTick()
      expect(panel.attributes('data-state')).toBe('collapsed')

      // Click again to expand
      await w.find('.bond-panel__header').trigger('click')
      await nextTick()
      expect(panel.attributes('data-state')).toBe('expanded')
      w.unmount()
    })

    it('renders static header without collapsible', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="vertical">
              <BondPanel id="top" :defaultSize="50" header="Static">
                <div>Content</div>
              </BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="bottom" :defaultSize="50">
                <div>Bottom</div>
              </BondPanel>
            </BondPanelGroup>
          `,
        }),
        { attachTo: document.body },
      )
      await nextTick()

      const header = w.find('.bond-panel__header')
      expect(header.exists()).toBe(true)
      expect(header.text()).toContain('Static')
      // No chevron on static header
      expect(w.find('.bond-panel__chevron').exists()).toBe(false)
      w.unmount()
    })

    it('supports header-extra slot', async () => {
      const w = mount(
        defineComponent({
          components: { BondPanelGroup, BondPanel, BondPanelHandle },
          template: `
            <BondPanelGroup direction="vertical">
              <BondPanel id="top" :defaultSize="50" header="Chats">
                <template #header-extra>
                  <button class="extra-btn">+</button>
                </template>
                <div>Content</div>
              </BondPanel>
              <BondPanelHandle id="handle-0" />
              <BondPanel id="bottom" :defaultSize="50">
                <div>Bottom</div>
              </BondPanel>
            </BondPanelGroup>
          `,
        }),
        { attachTo: document.body },
      )
      await nextTick()

      expect(w.find('.extra-btn').exists()).toBe(true)
      w.unmount()
    })
  })

  describe('error handling', () => {
    it('BondPanel throws when used outside BondPanelGroup', () => {
      expect(() => {
        mount(BondPanel, {
          props: { id: 'orphan', defaultSize: 50 },
          slots: { default: 'content' },
        })
      }).toThrow('BondPanel must be used inside BondPanelGroup')
    })

    it('BondPanelHandle throws when used outside BondPanelGroup', () => {
      expect(() => {
        mount(BondPanelHandle, {
          props: { id: 'orphan-handle' },
        })
      }).toThrow('BondPanelHandle must be used inside BondPanelGroup')
    })
  })
})
