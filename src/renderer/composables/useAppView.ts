import { ref, watch } from 'vue'

export type AppView = 'chat' | 'media' | 'collections' | 'sense'

const STORAGE_KEY = 'bond:activeView'

const activeView = ref<AppView>('chat')

watch(activeView, (v) => localStorage.setItem(STORAGE_KEY, v))

export function useAppView() {
  return { activeView }
}
