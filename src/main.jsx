import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { I18nProvider } from './i18n/I18nProvider.jsx';
import { initViewportHeight } from './lib/viewportHeight.js';
import './styles.css';

initViewportHeight();

createRoot(document.getElementById('root')).render(
  <I18nProvider>
    <App />
  </I18nProvider>,
);
