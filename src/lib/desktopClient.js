let cachedServiceConfigPromise = null;
let cachedEventSource = null;
let cachedEventSourceKey = '';
const SERVICE_CONFIG_RETRY_DELAY_MS = 160;
const INVOKE_RETRY_DELAYS_MS = [0, 180, 320, 520, 760];

function getBridge() {
  if (typeof window !== 'undefined' && window.synergyDesktop) {
    return window.synergyDesktop;
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function getServiceConfig() {
  if (!cachedServiceConfigPromise) {
    cachedServiceConfigPromise = (async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const bridge = getBridge();
        if (bridge?.getServiceConfig) {
          const config = await bridge.getServiceConfig();
          if (config?.baseUrl && config?.token) {
            return config;
          }
        }

        await sleep(SERVICE_CONFIG_RETRY_DELAY_MS);
      }

      throw new Error('Electron desktop bridge is unavailable.');
    })();
  }

  try {
    return await cachedServiceConfigPromise;
  } catch (error) {
    cachedServiceConfigPromise = null;
    throw error;
  }
}

export async function invoke(command, args = {}) {
  const bridge = getBridge();
  if (bridge?.invokeService) {
    return bridge.invokeService(command, args);
  }

  const config = await getServiceConfig();
  let lastError = null;

  for (let index = 0; index < INVOKE_RETRY_DELAYS_MS.length; index += 1) {
    const delayMs = INVOKE_RETRY_DELAYS_MS[index];
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
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
    } catch (error) {
      lastError = error;
      const isNetworkError = error instanceof TypeError;
      if (!isNetworkError || index === INVOKE_RETRY_DELAYS_MS.length - 1) {
        break;
      }
    }
  }

  if (lastError instanceof TypeError) {
    throw new Error(`Control service is not reachable yet for "${command}".`);
  }

  throw lastError;
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

export async function openPath(targetPath) {
  const bridge = getBridge();
  if (bridge?.openPath) {
    return bridge.openPath(targetPath);
  }
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
