import { createApp } from 'vue'
import './app.css'
import ViewerWindow from './ViewerWindow.vue'
import { vTooltip } from './directives/tooltip'

createApp(ViewerWindow).directive('tooltip', vTooltip).mount('#app')
