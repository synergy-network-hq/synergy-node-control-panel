let cachedServiceConfigPromise = null;
let cachedEventSource = null;
let cachedEventSourceKey = '';

function getBridge() {
  if (typeof window !== 'undefined' && window.synergyDesktop) {
    return window.synergyDesktop;
  }
  return null;
}

async function getServiceConfig() {
  if (!cachedServiceConfigPromise) {
    const bridge = getBridge();
    if (!bridge?.getServiceConfig) {
      cachedServiceConfigPromise = Promise.reject(new Error('Electron desktop bridge is unavailable.'));
    } else {
      cachedServiceConfigPromise = bridge.getServiceConfig();
    }
  }
  return cachedServiceConfigPromise;
}

export async function invoke(command, args = {}) {
  const config = await getServiceConfig();
  const response = await fetch(`${config.baseUrl}/v1/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      command,
      args,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(String(payload?.error || `Command failed: ${command}`));
  }

  return payload?.data;
}

function getEventSourceKey(config) {
  return `${config.baseUrl}:${config.token}`;
}

async function getEventSource() {
  const config = await getServiceConfig();
  const nextKey = getEventSourceKey(config);
  if (!cachedEventSource || cachedEventSourceKey !== nextKey) {
    if (cachedEventSource) {
      cachedEventSource.close();
    }
    cachedEventSource = new EventSource(
      `${config.baseUrl}/v1/events/stream?token=${encodeURIComponent(config.token)}`,
    );
    cachedEventSourceKey = nextKey;
  }
  return cachedEventSource;
}

export async function listen(eventName, handler) {
  const source = await getEventSource();
  const listener = (event) => {
    let payload = event.data;
    try {
      payload = JSON.parse(event.data);
    } catch {
      // Keep string payloads as-is.
    }
    handler({
      event: eventName,
      payload,
    });
  };

  source.addEventListener(eventName, listener);
  return () => {
    source.removeEventListener(eventName, listener);
  };
}

export async function getVersion() {
  const bridge = getBridge();
  if (!bridge?.getVersion) {
    return 'unknown';
  }
  return bridge.getVersion();
}

export async function openHelpWindow() {
  const bridge = getBridge();
  if (bridge?.openHelpWindow) {
    return bridge.openHelpWindow();
  }
  if (typeof window !== 'undefined') {
    window.location.hash = '/help';
  }
  return null;
}

export async function openExternal(url) {
  const bridge = getBridge();
  if (bridge?.openExternal) {
    return bridge.openExternal(url);
  }
  window.open(url, '_blank', 'noreferrer');
  return null;
}

export async function showSaveDialog(options = {}) {
  const bridge = getBridge();
  if (!bridge?.showSaveDialog) {
    return null;
  }
  return bridge.showSaveDialog(options);
}

export async function writeTextFile(path, contents) {
  const bridge = getBridge();
  if (!bridge?.writeTextFile) {
    throw new Error('File writing is unavailable in this runtime.');
  }
  return bridge.writeTextFile(path, contents);
}

export async function relaunchApp() {
  const bridge = getBridge();
  if (!bridge?.relaunch) {
    return null;
  }
  return bridge.relaunch();
}
