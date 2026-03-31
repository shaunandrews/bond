import { createApp } from 'vue'
import SettingsWindow from './SettingsWindow.vue'
import { vTooltip } from './directives/tooltip'

createApp(SettingsWindow).directive('tooltip', vTooltip).mount('#app')
