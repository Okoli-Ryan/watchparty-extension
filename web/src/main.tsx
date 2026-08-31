import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { trackViewportHeight } from './viewport';
import './styles.css';

// Must run before first paint so the app is never briefly 100vh tall on a phone.
trackViewportHeight();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
