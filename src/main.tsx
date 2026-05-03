import React from 'react';
import ReactDOM from 'react-dom/client';

try {
  const CURRENT_STORAGE_VERSION = '1.1';
  const version = localStorage.getItem('app_storage_version');
  if (version !== CURRENT_STORAGE_VERSION) {
    console.warn('Storage version mismatch. Clearing app cache keys...');
    localStorage.removeItem('wizard-storage');
    localStorage.removeItem('encuentros_general');
    // NOT removing 'puntoencuentro_host_id' to preserve user data link
    localStorage.setItem('app_storage_version', CURRENT_STORAGE_VERSION);
  }
} catch (e) {
  console.error('Storage migration error:', e);
}

import App from '@/App.tsx';
import './index.css';
import './i18n/i18n.ts';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
