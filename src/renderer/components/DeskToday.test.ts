import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import DeskToday from './DeskToday.vue'
import type { CollectionItem } from '../../shared/session'

type TodayItem = CollectionItem & { threadId: string | null }

function item(over: Partial<TodayItem> & { title?: string; status?: string } = {}): TodayItem {
  const { title, status, ...rest } = over
  return {
    id: over.id ?? 'i1',
    collectionId: 'c1',
    data: { title: title ?? 'Call the ISP', status: status ?? 'todo' },
    sortOrder: 0,
    createdAt: 'x',
    updatedAt: 'x',
    threadId: null,
    ...rest,
  } as TodayItem
}

describe('DeskToday', () => {
  it('says so when the list is empty', () => {
    const wrapper = mount(DeskToday, { props: { items: [] } })
    expect(wrapper.text()).toContain("Nothing on today's list")
  })

  it('renders titles with checkboxes', () => {
    const wrapper = mount(DeskToday, { props: { items: [item()] } })
    expect(wrapper.text()).toContain('Call the ISP')
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(true)
  })

  it('checks off done and cancelled items', () => {
    const wrapper = mount(DeskToday, {
      props: { items: [item({ id: 'a', status: 'done' }), item({ id: 'b', status: 'cancelled' })] },
    })
    const boxes = wrapper.findAll('input[type="checkbox"]')
    expect((boxes[0].element as HTMLInputElement).checked).toBe(true)
    expect((boxes[1].element as HTMLInputElement).checked).toBe(true)
  })

  it('sorts open work above finished work', () => {
    const wrapper = mount(DeskToday, {
      props: {
        items: [
          item({ id: 'done', title: 'Already handled', status: 'done' }),
          item({ id: 'open', title: 'Still to do', status: 'todo' }),
        ],
      },
    })
    const titles = wrapper.findAll('.desk-todo-title').map(n => n.text())
    expect(titles).toEqual(['Still to do', 'Already handled'])
  })

  it('emits a toggle with the new state', async () => {
    const wrapper = mount(DeskToday, { props: { items: [item()] } })
    const box = wrapper.find('input[type="checkbox"]')
    ;(box.element as HTMLInputElement).checked = true
    await box.trigger('change')
    expect(wrapper.emitted('toggle')![0]).toEqual(['i1', true])
  })

  it('marks a todo that is linked to observed work', () => {
    const wrapper = mount(DeskToday, { props: { items: [item({ threadId: 't1' })] } })
    expect(wrapper.find('.desk-todo-link').exists()).toBe(true)
  })

  it('does not mark an unlinked todo', () => {
    const wrapper = mount(DeskToday, { props: { items: [item()] } })
    expect(wrapper.find('.desk-todo-link').exists()).toBe(false)
  })

  it('adds a todo on Enter and clears the field', async () => {
    const wrapper = mount(DeskToday, { props: { items: [] } })
    const input = wrapper.find('.desk-todo-add')
    ;(input.element as HTMLInputElement).value = '  Fix the router  '
    await input.trigger('keydown.enter')

    expect(wrapper.emitted('add')![0]).toEqual(['Fix the router'])
    expect((input.element as HTMLInputElement).value).toBe('')
  })

  it('ignores an empty add', async () => {
    const wrapper = mount(DeskToday, { props: { items: [] } })
    const input = wrapper.find('.desk-todo-add')
    ;(input.element as HTMLInputElement).value = '   '
    await input.trigger('keydown.enter')
    expect(wrapper.emitted('add')).toBeUndefined()
  })

  it('falls back to Untitled for a item with no title', () => {
    const wrapper = mount(DeskToday, { props: { items: [item({ title: '' })] } })
    expect(wrapper.text()).toContain('Untitled')
  })

  it('disables everything while a write is in flight', () => {
    const wrapper = mount(DeskToday, { props: { items: [item()], busy: true } })
    expect(wrapper.find('input[type="checkbox"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.desk-todo-add').attributes('disabled')).toBeDefined()
  })
})
