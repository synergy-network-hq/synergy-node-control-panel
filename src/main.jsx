import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './styles/palette.css';
import './styles/typography.css';
import './styles/animations.css';
import './styles/synergy.css';
import './styles.css';
import './styles/monitor.css';
import './styles/controlPanelRevamp.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
