import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import QuestionPrompt from './QuestionPrompt.vue'

const BASE_PROPS = {
  questionId: 'q-1',
  question: 'Which approach?',
  header: 'Decision',
  options: [
    { id: 'q-1:0', number: 1, label: 'Balanced', description: 'Middle ground' },
    { id: 'q-1:1', number: 2, label: 'Aggressive', description: 'Faster but riskier' },
  ],
}

describe('QuestionPrompt', () => {
  it('shows the question and compact options', () => {
    const wrapper = mount(QuestionPrompt, { props: BASE_PROPS })

    expect(wrapper.text()).toContain('Which approach?')
    expect(wrapper.text()).toContain('Balanced')
    expect(wrapper.text()).toContain('Middle ground')
    expect(wrapper.text()).toContain('Aggressive')
  })

  it('clicking an option emits the option answer', async () => {
    const wrapper = mount(QuestionPrompt, { props: BASE_PROPS })

    await wrapper.findAll('.question-option')[1].trigger('click')

    expect(wrapper.emitted('answer')).toEqual([
      ['q-1', { kind: 'option', optionId: 'q-1:1', label: 'Aggressive', number: 2 }],
    ])
  })

  it('clicking the dismiss button emits a cancelled answer', async () => {
    const wrapper = mount(QuestionPrompt, { props: BASE_PROPS, attachTo: document.body })

    await wrapper.find('button').trigger('click')

    expect(wrapper.emitted('answer')).toEqual([['q-1', { kind: 'cancelled' }]])
    wrapper.unmount()
  })

  it('Escape dismisses the question', () => {
    const wrapper = mount(QuestionPrompt, { props: BASE_PROPS, attachTo: document.body })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(wrapper.emitted('answer')).toEqual([['q-1', { kind: 'cancelled' }]])
    wrapper.unmount()
  })

  it('gives each option an accessible label naming its text and description', () => {
    const wrapper = mount(QuestionPrompt, { props: BASE_PROPS })
    const options = wrapper.findAll('.question-option')

    expect(options[0].attributes('aria-label')).toBe('Balanced. Middle ground')
    expect(options[1].attributes('aria-label')).toBe('Aggressive. Faster but riskier')
  })
})
