import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import App from './App.jsx'
import { applyTheme } from './theme.js'
import './styles.css'

applyTheme()
createRoot(document.getElementById('root')).render(<App />)
