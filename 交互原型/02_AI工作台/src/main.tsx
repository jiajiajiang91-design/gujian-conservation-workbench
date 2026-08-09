import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('应用挂载点不存在')
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
