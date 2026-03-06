import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

const HELP_WINDOW_LABEL = 'help-articles-window';
const HELP_HASH_ROUTE = '/help';
const HELP_WINDOW_URL = `/#${HELP_HASH_ROUTE}`;

function openHelpInCurrentWindow() {
  if (typeof window !== 'undefined') {
    window.location.hash = HELP_HASH_ROUTE;
  }
}

export async function openHelpWindow() {
  try {
    const existing = await WebviewWindow.getByLabel(HELP_WINDOW_LABEL);
    if (existing) {
      await existing.show();
      await existing.setFocus();
      return;
    }

    const helpWindow = new WebviewWindow(HELP_WINDOW_LABEL, {
      title: 'Synergy Devnet Control Panel Help',
      url: HELP_WINDOW_URL,
      center: true,
      width: 1080,
      height: 820,
      minWidth: 860,
      minHeight: 620,
      resizable: true,
    });

    helpWindow.once('tauri://error', (event) => {
      console.error('Failed to create help window:', event.payload);
      openHelpInCurrentWindow();
    });
  } catch (error) {
    console.error('Help window open failed, falling back to current window help route:', error);
    openHelpInCurrentWindow();
  }
}
