import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { NotchApi } from '@shared/types'
import { App } from './App'
import { PlatformProvider } from './platform'
import './styles.css'

declare global {
  interface Window {
    notch: NotchApi
  }
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <PlatformProvider>
        <App />
      </PlatformProvider>
    </StrictMode>
  )
}
