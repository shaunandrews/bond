import { ref } from 'vue'
import type { WordPressSite } from '../../shared/wordpress'

const STORAGE_KEY = 'bond:site-preview-open'

const url = ref('')
const isOpen = ref(localStorage.getItem(STORAGE_KEY) === '1')
const loading = ref(false)
const title = ref('')
const canGoBack = ref(false)
const canGoForward = ref(false)

function openSite(site: WordPressSite) {
  url.value = site.url
  title.value = site.name
  isOpen.value = true
  localStorage.setItem(STORAGE_KEY, '1')
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
    openSite,
    close,
    navigate,
  }
}
