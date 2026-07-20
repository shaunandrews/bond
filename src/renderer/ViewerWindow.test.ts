import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ViewerWindow from './ViewerWindow.vue'

let onViewerFileCallback: ((path: string, format?: 'markdown' | 'plaintext', title?: string) => void) | null = null

beforeEach(() => {
  onViewerFileCallback = null
  const mockBond = {
    readFile: vi.fn().mockResolvedValue('# Hello\n\nWorld'),
    onViewerFile: vi.fn((fn) => {
      onViewerFileCallback = fn
      return () => {}
    }),
  }
  ;(window as any).bond = mockBond
})

describe('ViewerWindow', () => {
  it('renders markdown content by default', async () => {
    const wrapper = mount(ViewerWindow)
    onViewerFileCallback!('/path/to/file.md')
    await flushPromises()

    expect(wrapper.find('.viewer-body').exists()).toBe(true)
    expect(wrapper.find('.plaintext-body').exists()).toBe(false)
  })

  it('renders a plaintext block when format is plaintext', async () => {
    const wrapper = mount(ViewerWindow)
    onViewerFileCallback!('/path/to/file.txt', 'plaintext', 'Notes')
    await flushPromises()

    const pre = wrapper.find('.plaintext-body')
    expect(pre.exists()).toBe(true)
    expect(pre.text()).toContain('Hello')
  })

  it('uses the provided title for the toolbar label instead of the path', async () => {
    const wrapper = mount(ViewerWindow)
    onViewerFileCallback!('/path/to/some-uuid-1234.md', 'markdown', 'Studio catch-up')
    await flushPromises()

    expect(wrapper.text()).toContain('Studio catch-up')
    expect(wrapper.text()).not.toContain('some-uuid-1234.md')
  })

  it('falls back to the filename when no title is given', async () => {
    const wrapper = mount(ViewerWindow)
    onViewerFileCallback!('/path/to/report.md')
    await flushPromises()

    expect(wrapper.text()).toContain('report.md')
  })

  it('shows an error state when the file cannot be read', async () => {
    ;(window.bond.readFile as any).mockResolvedValueOnce(null)
    const wrapper = mount(ViewerWindow)
    onViewerFileCallback!('/path/to/missing.md')
    await flushPromises()

    expect(wrapper.text()).toContain('File not found or cannot be read.')
  })
})
