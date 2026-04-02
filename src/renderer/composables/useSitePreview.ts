import { ref } from 'vue'
import type { WordPressSite } from '../../shared/wordpress'

const STORAGE_KEY = 'bond:site-preview-open'

const url = ref('')
const isOpen = ref(localStorage.getItem(STORAGE_KEY) === '1')
const loading = ref(false)
const title = ref('')
const canGoBack = ref(false)
const canGoForward = ref(false)
const site = ref<WordPressSite | null>(null)
const transitioning = ref(false)

function openSite(s: WordPressSite) {
  const changing = site.value != null && site.value.path !== s.path
  site.value = s
  url.value = s.url
  title.value = s.name
  isOpen.value = true
  if (changing) transitioning.value = true
  localStorage.setItem(STORAGE_KEY, '1')
}

function setSite(s: WordPressSite | null) {
  site.value = s
  title.value = s?.name ?? ''
}

function close() {
  isOpen.value = false
  localStorage.setItem(STORAGE_KEY, '0')
}

function navigate(newUrl: string) {
  url.value = newUrl
}

export function useSitePreview() {
  return {
    url,
    isOpen,
    loading,
    title,
    canGoBack,
    canGoForward,
    site,
    transitioning,
    openSite,
    setSite,
    close,
    navigate,
  }
}
