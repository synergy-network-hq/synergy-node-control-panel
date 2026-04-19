import { useEffect, useState } from 'react';
import { writeStoredDeveloperMode } from './developerMode';

const VIEW_MODE_STORAGE_KEY = 'synergy:testbeta:view-mode:v1';
const VIEW_MODE_EVENT = 'synergy:testbeta:view-mode-change';
const VIEW_MODES = new Set(['basic', 'expert', 'developer']);

function getLocalStorage() {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalizeViewMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return VIEW_MODES.has(normalized) ? normalized : 'basic';
}

export function readStoredViewMode() {
  const storage = getLocalStorage();
  if (!storage) {
    return 'basic';
  }

  try {
    return normalizeViewMode(storage.getItem(VIEW_MODE_STORAGE_KEY));
  } catch {
    return 'basic';
  }
}

export function writeStoredViewMode(value) {
  const normalized = normalizeViewMode(value);
  const storage = getLocalStorage();

  if (storage) {
    try {
      storage.setItem(VIEW_MODE_STORAGE_KEY, normalized);
    } catch {
      // Keep dispatch behavior even if storage is unavailable.
    }
  }

  writeStoredDeveloperMode(normalized === 'developer');

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(VIEW_MODE_EVENT, {
      detail: { mode: normalized },
    }));
  }

  return normalized;
}

export function usePanelViewMode() {
  const [viewMode, setViewMode] = useState(() => readStoredViewMode());

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const sync = () => {
      setViewMode(readStoredViewMode());
    };

    const handleStorage = (event) => {
      if (!event || event.key == null || event.key === VIEW_MODE_STORAGE_KEY) {
        sync();
      }
    };

    const handleChange = (event) => {
      if (event?.detail?.mode) {
        setViewMode(normalizeViewMode(event.detail.mode));
        return;
      }

      sync();
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(VIEW_MODE_EVENT, handleChange);

    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(VIEW_MODE_EVENT, handleChange);
    };
  }, []);

  const updateViewMode = (nextValue) => {
    const resolved = typeof nextValue === 'function'
      ? nextValue(viewMode)
      : nextValue;
    const normalized = writeStoredViewMode(resolved);
    setViewMode(normalized);
    return normalized;
  };

  return [viewMode, updateViewMode];
}

export function modeLabel(viewMode) {
  switch (normalizeViewMode(viewMode)) {
    case 'expert':
      return 'Expert';
    case 'developer':
      return 'Developer';
    case 'basic':
    default:
      return 'Basic';
  }
}
