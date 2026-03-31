import { createApp } from 'vue'
import App from './App.vue'
import { vTooltip } from './directives/tooltip'

createApp(App).directive('tooltip', vTooltip).mount('#app')
