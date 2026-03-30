import { ref, watch } from 'vue'

export type AppView = 'chat' | 'design-system' | 'components' | 'settings' | 'about'

const STORAGE_KEY = 'bond:activeView'
const VALID_VIEWS: AppView[] = ['chat', 'design-system', 'components', 'settings', 'about']

function loadView(): AppView {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored && VALID_VIEWS.includes(stored as AppView) ? (stored as AppView) : 'chat'
}

const activeView = ref<AppView>(loadView())

watch(activeView, (v) => localStorage.setItem(STORAGE_KEY, v))

export function useAppView() {
  return { activeView }
}
