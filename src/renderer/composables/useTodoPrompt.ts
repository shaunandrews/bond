import { ref, type Ref } from 'vue'
import type { TodoItem } from '../../shared/session'

interface UseTodoPromptOptions {
  projectId?: Ref<string | undefined>
  existingGroups?: Ref<string[]>
}

interface SubmitOptions {
  literal?: boolean
}

interface SubmitResult {
  todos: TodoItem[]
  fallback: boolean
}

export function useTodoPrompt(options?: UseTodoPromptOptions) {
  const text = ref('')
  const parsing = ref(false)

  async function submit(opts?: SubmitOptions): Promise<SubmitResult> {
    const raw = text.value.trim()
    if (!raw || parsing.value) return { todos: [], fallback: false }

    const pid = options?.projectId?.value

    // Literal mode (Shift+Enter) — skip AI, create one todo as-is
    if (opts?.literal) {
      const todo = await window.bond.createTodo(raw, '', '', pid)
      text.value = ''
      return { todos: [todo], fallback: false }
    }

    parsing.value = true
    try {
      const { todos: parsed } = await window.bond.parseFromPrompt(
        raw,
        options?.existingGroups?.value
      )

      // Fallback: AI returned nothing → use literal text
      if (!parsed.length) {
        const todo = await window.bond.createTodo(raw, '', '', pid)
        text.value = ''
        return { todos: [todo], fallback: true }
      }

      const created: TodoItem[] = []
      for (const p of parsed) {
        created.push(await window.bond.createTodo(p.title, p.notes, p.group, pid))
      }
      text.value = ''
      return { todos: created, fallback: false }
    } catch {
      // AI failed — fall back to literal creation
      const todo = await window.bond.createTodo(raw, '', '', pid)
      text.value = ''
      return { todos: [todo], fallback: true }
    } finally {
      parsing.value = false
    }
  }

  return { text, parsing, submit }
}
