import React from 'react';
import ReactDOM from 'react-dom/client';

try {
  const CURRENT_STORAGE_VERSION = '1.2';
  const version = localStorage.getItem('app_storage_version');
  
  if (version !== CURRENT_STORAGE_VERSION) {
    console.warn(`Storage version mismatch (${version} vs ${CURRENT_STORAGE_VERSION}). Clearing cache...`);
    localStorage.removeItem('wizard-storage');
    localStorage.removeItem('encuentros_general');
    // We keep puntoencuentro_host_id to avoid losing link to existing meetings
    localStorage.setItem('app_storage_version', CURRENT_STORAGE_VERSION);
  }

  // Extra safety: validate specific keys if they exist
  const wizardData = localStorage.getItem('wizard-storage');
  if (wizardData) {
    try {
      const parsed = JSON.parse(wizardData);
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid wizard data');
    } catch (e) {
      console.warn('Malformed wizard-storage found, removing...');
      localStorage.removeItem('wizard-storage');
    }
  }

  const generalData = localStorage.getItem('encuentros_general');
  if (generalData) {
    try {
      const parsed = JSON.parse(generalData);
      if (!parsed || typeof parsed !== 'object') throw new Error('Invalid general data');
    } catch (e) {
      console.warn('Malformed encuentros_general found, removing...');
      localStorage.removeItem('encuentros_general');
    }
  }
} catch (e) {
  console.error('Critical storage migration error:', e);
}

import App from '@/App.tsx';
import './index.css';
import './i18n/i18n.ts';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
