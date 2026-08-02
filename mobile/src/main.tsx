import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { MockBridge } from './mockBridge'
import { RemoteBridge } from './remoteBridge'
import './styles.css'

const params = new URLSearchParams(window.location.search)
const useDemo = params.get('demo') === '1'
const bridge = useDemo ? new MockBridge() : new RemoteBridge()

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js')
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App bridge={bridge} />
  </StrictMode>
)
