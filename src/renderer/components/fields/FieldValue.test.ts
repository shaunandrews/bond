import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import FieldValue from './FieldValue.vue'
import type { FieldDef } from '../../../shared/session'

const statusDef: FieldDef = {
  name: 'status',
  type: 'status',
  options: [
    { value: 'open', category: 'open', color: 'gray' },
    { value: 'done', label: 'Done!', category: 'done', color: 'green' },
  ],
}

describe('FieldValue', () => {
  it('renders an em dash for empty values', () => {
    const wrapper = mount(FieldValue, { props: { value: null, def: { name: 't', type: 'text' } } })
    expect(wrapper.text()).toBe('—')
    expect(wrapper.find('.fv-empty').exists()).toBe(true)
  })

  it('renders rating as filled/empty stars', () => {
    const wrapper = mount(FieldValue, { props: { value: 3, def: { name: 'r', type: 'rating', max: 5 } } })
    expect(wrapper.findAll('.fv-star--filled')).toHaveLength(3)
    expect(wrapper.findAll('.fv-star--empty')).toHaveLength(2)
  })

  it('renders status as a colored chip with the option label', () => {
    const wrapper = mount(FieldValue, { props: { value: 'done', def: statusDef } })
    expect(wrapper.find('.fv-chip').text()).toBe('Done!')
    expect(wrapper.find('.fv-chip-dot').attributes('style')).toContain('--field-green')
  })

  it('renders priority as a chip via option order', () => {
    const def: FieldDef = { name: 'p', type: 'priority', options: [{ value: 'high', color: 'orange' }] }
    const wrapper = mount(FieldValue, { props: { value: 'high', def } })
    expect(wrapper.find('.fv-chip').exists()).toBe(true)
  })

  it('renders select as a plain badge', () => {
    const def: FieldDef = { name: 's', type: 'select', options: [{ value: 'Sense' }] }
    const wrapper = mount(FieldValue, { props: { value: 'Sense', def } })
    expect(wrapper.find('.fv-badge').text()).toBe('Sense')
  })

  it('renders tags as individual chips', () => {
    const wrapper = mount(FieldValue, { props: { value: ['a', 'b'], def: { name: 't', type: 'tags' } } })
    expect(wrapper.findAll('.fv-tag').map(t => t.text())).toEqual(['a', 'b'])
  })

  it('renders booleans as check or dash', () => {
    const on = mount(FieldValue, { props: { value: true, def: { name: 'b', type: 'boolean' } } })
    expect(on.find('.fv-bool--on').exists()).toBe(true)
    const off = mount(FieldValue, { props: { value: false, def: { name: 'b', type: 'boolean' } } })
    expect(off.text()).toBe('—')
  })

  it('opens urls through window.bond', async () => {
    const openExternal = vi.fn()
    ;(window as unknown as { bond: unknown }).bond = { openExternal }
    const wrapper = mount(FieldValue, { props: { value: 'https://a8c.com', def: { name: 'u', type: 'url' } } })
    await wrapper.find('.fv-link').trigger('click')
    expect(openExternal).toHaveBeenCalledWith('https://a8c.com')
    delete (window as unknown as { bond?: unknown }).bond
  })

  it('formats numbers with prefix and suffix', () => {
    const def: FieldDef = { name: 'n', type: 'number', prefix: '$', suffix: '/mo' }
    const wrapper = mount(FieldValue, { props: { value: 9, def } })
    expect(wrapper.text()).toBe('$9/mo')
  })

  it('never throws on garbage values', () => {
    const wrapper = mount(FieldValue, { props: { value: { junk: true }, def: { name: 'r', type: 'rating' } } })
    expect(wrapper.text()).toContain('junk')
  })
})
