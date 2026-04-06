import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FieldManual from './FieldManual.vue'

describe('FieldManual', () => {
  it('renders when open=true', () => {
    const wrapper = mount(FieldManual, { props: { open: true } })
    expect(wrapper.find('.field-manual-backdrop').exists()).toBe(true)
    expect(wrapper.find('.field-manual-card').exists()).toBe(true)
  })

  it('does not render when open=false', () => {
    const wrapper = mount(FieldManual, { props: { open: false } })
    expect(wrapper.find('.field-manual-backdrop').exists()).toBe(false)
  })

  it('emits close on Escape keydown', async () => {
    const wrapper = mount(FieldManual, { props: { open: true } })
    // The component registers a document-level keydown listener
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toBeTruthy()
    expect(wrapper.emitted('close')!.length).toBe(1)
  })

  it('emits close on backdrop click', async () => {
    const wrapper = mount(FieldManual, { props: { open: true } })
    await wrapper.find('.field-manual-backdrop').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('does not emit close when clicking inside the card', async () => {
    const wrapper = mount(FieldManual, { props: { open: true } })
    await wrapper.find('.field-manual-card').trigger('click')
    expect(wrapper.emitted('close')).toBeFalsy()
  })

  it('contains expected section headings', () => {
    const wrapper = mount(FieldManual, { props: { open: true } })
    const text = wrapper.text()
    expect(text).toContain('FIELD MANUAL')
    expect(text).toContain('Keyboard Shortcuts')
    expect(text).toContain('Capabilities')
    expect(text).toContain('Pro Tips')
  })

  it('displays all keyboard shortcuts', () => {
    const wrapper = mount(FieldManual, { props: { open: true } })
    const text = wrapper.text()
    expect(text).toContain('⌘B')
    expect(text).toContain('Toggle sidebar')
    expect(text).toContain('⌘N')
    expect(text).toContain('New chat')
  })

  it('displays all capability names', () => {
    const wrapper = mount(FieldManual, { props: { open: true } })
    const text = wrapper.text()
    const capabilities = ['Chat', 'Projects', 'Todos', 'Journal', 'Collections', 'Media Library', 'Sense', 'Browser', 'Operatives', 'Skills']
    for (const cap of capabilities) {
      expect(text).toContain(cap)
    }
  })
})
