import './styles.css'

import type { BondStreamChunk } from '../shared/stream'

declare global {
  interface Window {
    bond: {
      send: (text: string) => Promise<{ ok: boolean; error?: string }>
      cancel: () => Promise<{ ok: boolean }>
      onChunk: (fn: (chunk: BondStreamChunk) => void) => () => void
    }
  }
}

const chat = document.getElementById('chat')!
const input = document.getElementById('input') as HTMLTextAreaElement
const sendBtn = document.getElementById('send') as HTMLButtonElement
const cancelBtn = document.getElementById('cancel') as HTMLButtonElement

function appendBubble(role: 'user' | 'bond' | 'meta', html: string): HTMLElement {
  const el = document.createElement('div')
  el.className = `bubble bubble-${role}`
  el.innerHTML = html
  chat.appendChild(el)
  chat.scrollTop = chat.scrollHeight
  return el
}

function appendBondText(text: string): void {
  const last = chat.lastElementChild as HTMLElement | null
  if (last?.classList.contains('bubble-bond') && last.dataset.streaming === '1') {
    const body = last.querySelector('.body')
    if (body) {
      body.textContent = (body.textContent ?? '') + text
      chat.scrollTop = chat.scrollHeight
      return
    }
  }
  const el = appendBubble('bond', '<div class="body"></div>')
  el.dataset.streaming = '1'
  const body = el.querySelector('.body')!
  body.textContent = text
}

function endBondStream(): void {
  const last = chat.lastElementChild as HTMLElement | null
  if (last?.dataset.streaming === '1') delete last.dataset.streaming
}

function setBusy(busy: boolean): void {
  sendBtn.disabled = busy
  cancelBtn.disabled = !busy
  input.disabled = busy
}

function handleChunk(chunk: BondStreamChunk): void {
  switch (chunk.kind) {
    case 'assistant_text':
      appendBondText(chunk.text)
      break
    case 'assistant_tool': {
      const detail = chunk.summary ? ` — ${chunk.summary}` : ''
      appendBubble('meta', `<span class="tool">${escapeHtml(chunk.name)}</span>${escapeHtml(detail)}`)
      break
    }
    case 'auth_status': {
      const lines = chunk.lines.map((l) => escapeHtml(l)).join('<br/>')
      appendBubble('meta', `<strong>Auth</strong><br/>${lines}${chunk.error ? `<br/><span class="err">${escapeHtml(chunk.error)}</span>` : ''}`)
      break
    }
    case 'system':
      appendBubble('meta', escapeHtml(chunk.text ?? chunk.subtype))
      break
    case 'result':
      // Success `result` from the SDK repeats assistant text already streamed as `assistant_text`.
      if (chunk.errors?.length) {
        appendBubble('meta', `<span class="err">${escapeHtml(chunk.errors.join('; '))}</span>`)
      }
      endBondStream()
      break
    case 'raw_error':
      appendBubble('meta', `<span class="err">${escapeHtml(chunk.message)}</span>`)
      endBondStream()
      break
    default:
      break
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

window.bond.onChunk(handleChunk)

async function submit(): Promise<void> {
  const text = input.value.trim()
  if (!text) return
  appendBubble('user', escapeHtml(text).replace(/\n/g, '<br/>'))
  input.value = ''
  setBusy(true)
  try {
    const res = await window.bond.send(text)
    if (!res.ok && res.error) {
      appendBubble('meta', `<span class="err">${escapeHtml(res.error)}</span>`)
    }
  } finally {
    setBusy(false)
    endBondStream()
  }
}

sendBtn.addEventListener('click', () => void submit())
cancelBtn.addEventListener('click', () => void window.bond.cancel())

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void submit()
  }
})

appendBubble(
  'meta',
  'Auth: add <code>ANTHROPIC_API_KEY</code> to <code>.env</code> (from the <a href="https://console.anthropic.com/">Claude Console</a>). The Agent SDK uses API access; if you use Claude subscription auth via the Claude Code CLI, the same login can apply to the underlying Claude Code runtime—see Anthropic’s Agent SDK auth docs. File tools use your home directory as the session root.'
)
