import { ref } from 'vue'

export type AppView = 'chat' | 'design-system' | 'components' | 'settings'

export function useAppView() {
  const activeView = ref<AppView>('chat')
  return { activeView }
}
