import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ApprovalPrompt from './ApprovalPrompt.vue'
import BondButton from './BondButton.vue'

describe('ApprovalPrompt', () => {
  it('shows the approval context and command', () => {
    const wrapper = mount(ApprovalPrompt, {
      props: {
        requestId: 'req-1',
        toolName: 'Bash',
        description: 'Run the test suite',
        input: { command: 'npm run test:run' },
      },
    })

    expect(wrapper.text()).toContain('Bash needs approval')
    expect(wrapper.text()).toContain('Run the test suite')
    expect(wrapper.text()).toContain('npm run test:run')
  })

  it('emits allow and deny decisions', async () => {
    const wrapper = mount(ApprovalPrompt, {
      props: { requestId: 'req-1', toolName: 'Write', input: { path: 'file.ts' } },
    })
    const buttons = wrapper.findAllComponents(BondButton)

    await buttons[0].trigger('click')
    await buttons[1].trigger('click')

    expect(wrapper.emitted('respond')).toEqual([
      ['req-1', true],
      ['req-1', false],
    ])
  })
})
