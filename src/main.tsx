import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/jost/latin-400.css';
import '@fontsource/jost/latin-500.css';
import '@fontsource/jost/latin-600.css';
import './styles.css';
import './explorer.css';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
