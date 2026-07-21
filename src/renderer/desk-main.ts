import { createApp } from 'vue'
// Order matters: desk.css strips the window chrome app.css sets on #app.
import './app.css'
import './desk.css'
import DeskWindow from './DeskWindow.vue'

createApp(DeskWindow).mount('#app')
