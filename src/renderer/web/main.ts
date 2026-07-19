import { createApp } from 'vue'
import '../app.css'
import WebApp from './WebApp.vue'
import { vTooltip } from '../directives/tooltip'
import { WebBondClient, readPairingToken } from './client'
import { buildBondShim } from './shim'

// The shim must exist before any component mounts — the renderer reads
// window.bond directly throughout.
const token = readPairingToken()
const client = new WebBondClient({
  url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/`,
  token: token ?? '',
})
window.bond = buildBondShim(client)
if (token) client.connect()

createApp(WebApp, { client, hasToken: !!token })
  .directive('tooltip', vTooltip)
  .mount('#app')
