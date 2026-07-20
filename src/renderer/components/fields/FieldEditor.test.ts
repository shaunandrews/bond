import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FieldEditor from './FieldEditor.vue'
import BondSelect from '../BondSelect.vue'
import type { FieldDef } from '../../../shared/session'

function lastEmitted(wrapper: ReturnType<typeof mount>): unknown {
  const events = wrapper.emitted('update:modelValue')
  return events?.[events.length - 1]?.[0]
}

describe('FieldEditor', () => {
  it('emits canonical numbers for number fields, undefined when cleared', async () => {
    const def: FieldDef = { name: 'price', type: 'number' }
    const wrapper = mount(FieldEditor, { props: { def, modelValue: undefined } })
    await wrapper.find('input').setValue('12.5')
    expect(lastEmitted(wrapper)).toBe(12.5)
    await wrapper.find('input').setValue('')
    expect(lastEmitted(wrapper)).toBeUndefined()
  })

  it('emits trimmed-empty text as undefined', async () => {
    const def: FieldDef = { name: 'title', type: 'text' }
    const wrapper = mount(FieldEditor, { props: { def, modelValue: 'old' } })
    await wrapper.find('input').setValue('   ')
    expect(lastEmitted(wrapper)).toBeUndefined()
  })

  it('renders a textarea for longtext', () => {
    const def: FieldDef = { name: 'details', type: 'longtext' }
    const wrapper = mount(FieldEditor, { props: { def, modelValue: undefined } })
    expect(wrapper.find('textarea').exists()).toBe(true)
  })

  it('toggles booleans', async () => {
    const def: FieldDef = { name: 'done', type: 'boolean' }
    const wrapper = mount(FieldEditor, { props: { def, modelValue: false } })
    await wrapper.find('.fe-toggle').trigger('click')
    expect(lastEmitted(wrapper)).toBe(true)
  })

  it('sets rating by star click and clears on repeat click', async () => {
    const def: FieldDef = { name: 'stars', type: 'rating', max: 5 }
    const wrapper = mount(FieldEditor, { props: { def, modelValue: 2 } })
    const stars = wrapper.findAll('.fe-star')
    await stars[3].trigger('click')
    expect(lastEmitted(wrapper)).toBe(4)
    await stars[1].trigger('click') // current value 2 → clears
    expect(lastEmitted(wrapper)).toBeUndefined()
  })

  it('adjusts rating with arrow keys', async () => {
    const def: FieldDef = { name: 'stars', type: 'rating', max: 5 }
    const wrapper = mount(FieldEditor, { props: { def, modelValue: 4 } })
    await wrapper.find('.fe-rating').trigger('keydown', { key: 'ArrowRight' })
    expect(lastEmitted(wrapper)).toBe(5)
    await wrapper.find('.fe-rating').trigger('keydown', { key: 'ArrowLeft' })
    expect(lastEmitted(wrapper)).toBe(3)
  })

  it('uses BondSelect with colored options for status fields and maps empty to undefined', async () => {
    const def: FieldDef = {
      name: 'status',
      type: 'status',
      options: [{ value: 'open', color: 'gray' }, { value: 'done', label: 'Done!', color: 'green' }],
    }
    const wrapper = mount(FieldEditor, { props: { def, modelValue: 'open' } })
    const select = wrapper.findComponent(BondSelect)
    expect(select.exists()).toBe(true)
    expect(select.props('options')).toEqual([
      { value: '', label: '—' },
      { value: 'open', label: 'open', color: 'var(--field-gray)' },
      { value: 'done', label: 'Done!', color: 'var(--field-green)' },
    ])
    select.vm.$emit('update:modelValue', '')
    expect(lastEmitted(wrapper)).toBeUndefined()
    select.vm.$emit('update:modelValue', 'done')
    expect(lastEmitted(wrapper)).toBe('done')
  })

  it('toggles multiselect membership via chips', async () => {
    const def: FieldDef = { name: 'genres', type: 'multiselect', options: [{ value: 'drama' }, { value: 'comedy' }] }
    const wrapper = mount(FieldEditor, { props: { def, modelValue: ['drama'] } })
    const chips = wrapper.findAll('.fe-chip')
    expect(chips[0].classes()).toContain('fe-chip--on')
    await chips[1].trigger('click')
    expect(lastEmitted(wrapper)).toEqual(['drama', 'comedy'])

    await wrapper.setProps({ modelValue: ['drama', 'comedy'] })
    await wrapper.findAll('.fe-chip')[0].trigger('click')
    expect(lastEmitted(wrapper)).toEqual(['comedy'])
  })

  it('adds tags on Enter, removes via chip button, and empties to undefined', async () => {
    const def: FieldDef = { name: 'tags', type: 'tags' }
    const wrapper = mount(FieldEditor, { props: { def, modelValue: ['a'] } })
    const input = wrapper.find('.fe-tag-input')
    await input.setValue('b')
    await input.trigger('keydown', { key: 'Enter' })
    expect(lastEmitted(wrapper)).toEqual(['a', 'b'])

    await wrapper.setProps({ modelValue: ['a', 'b'] })
    await wrapper.find('.fe-chip-remove').trigger('click')
    expect(lastEmitted(wrapper)).toEqual(['b'])

    await wrapper.setProps({ modelValue: ['b'] })
    await wrapper.find('.fe-chip-remove').trigger('click')
    expect(lastEmitted(wrapper)).toBeUndefined() // last tag removed → field cleared
  })

  it('renders a date input for dates', () => {
    const def: FieldDef = { name: 'due', type: 'date' }
    const wrapper = mount(FieldEditor, { props: { def, modelValue: '2026-07-19' } })
    const input = wrapper.find('input')
    expect(input.attributes('type')).toBe('date')
    expect((input.element as HTMLInputElement).value).toBe('2026-07-19')
  })
})
