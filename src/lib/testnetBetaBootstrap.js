import { fetchSeedPeerTargets, readTextFile, writeTextFile } from './desktopClient';

const BOOTSTRAP_DNS_RECORD = '_dnsaddr.bootstrap.synergynode.xyz';
const PORT_SETTINGS_STORAGE_KEY = 'synergy:testbeta:port-settings:v1';
const TESTNET_ENDPOINTS = {
  coreRpc: 'https://testbeta-core-rpc.synergy-network.io',
  coreWs: 'wss://testbeta-core-ws.synergy-network.io',
  walletApi: 'https://testbeta-wallet-api.synergy-network.io',
  sxcpApi: 'https://testbeta-sxcp-api.synergy-network.io',
};

const TESTNET_BETA_DEFAULT_PORT_SETTINGS = Object.freeze({
  p2p: 38638,
  rpc: 48638,
  ws: 58638,
  discovery: 30301,
  metrics: 9090,
});

const TESTNET_BETA_PORT_FIELDS = Object.freeze([
  {
    key: 'p2p',
    label: 'P2P',
    detail: 'Peer listener and advertised external peer port.',
  },
  {
    key: 'rpc',
    label: 'RPC',
    detail: 'HTTP and gRPC port used by the local node.',
  },
  {
    key: 'ws',
    label: 'WebSocket',
    detail: 'WebSocket port used by the local node.',
  },
  {
    key: 'discovery',
    label: 'Discovery',
    detail: 'Peer discovery service port used by the local node.',
  },
  {
    key: 'metrics',
    label: 'Metrics',
    detail: 'Local telemetry metrics port used by the local node.',
  },
]);

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

function cloneDefaultPortSettings() {
  return { ...TESTNET_BETA_DEFAULT_PORT_SETTINGS };
}

function normalizeStoredPortSettings(value) {
  const normalized = cloneDefaultPortSettings();
  const source = value && typeof value === 'object' ? value : {};

  TESTNET_BETA_PORT_FIELDS.forEach(({ key }) => {
    const parsed = Number.parseInt(String(source[key] ?? '').trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      normalized[key] = parsed;
    }
  });

  return normalized;
}

function parsePortValue(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return null;
  }
  return parsed;
}

function isIpv4Address(host) {
  const segments = String(host || '').split('.');
  if (segments.length !== 4) {
    return false;
  }

  return segments.every((segment) => {
    if (!/^\d+$/.test(segment)) {
      return false;
    }
    const value = Number.parseInt(segment, 10);
    return value >= 0 && value <= 255;
  });
}

function isIpv6Address(host) {
  const normalized = String(host || '').trim();
  return normalized.includes(':') && /^[0-9a-fA-F:]+$/.test(normalized);
}

function isPlausibleDialHost(host) {
  const normalized = String(host || '').trim();
  if (!normalized) {
    return false;
  }

  if (normalized.toLowerCase() === 'localhost') {
    return true;
  }

  if (isIpv4Address(normalized) || isIpv6Address(normalized)) {
    return true;
  }

  return normalized.includes('.') && /^[a-zA-Z0-9.-]+$/.test(normalized);
}

function normalizeHostPort(host, port) {
  const normalizedHost = String(host || '')
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.+$/, '');
  const normalizedPort = Number.parseInt(String(port || '').trim(), 10);

  if (!Number.isInteger(normalizedPort) || normalizedPort <= 0 || normalizedPort > 65535) {
    return null;
  }

  if (!isPlausibleDialHost(normalizedHost)) {
    return null;
  }

  if (isIpv6Address(normalizedHost)) {
    return `[${normalizedHost}]:${normalizedPort}`;
  }

  return `${normalizedHost}:${normalizedPort}`;
}

function normalizeDialTarget(value) {
  const dial = String(value || '').trim();
  if (!dial) {
    return null;
  }

  if (dial.startsWith('[')) {
    const stripped = dial.slice(1);
    const parts = stripped.split(']:');
    if (parts.length === 2) {
      return normalizeHostPort(parts[0], parts[1]);
    }
  }

  const separatorIndex = dial.lastIndexOf(':');
  if (separatorIndex <= 0) {
    return null;
  }

  return normalizeHostPort(dial.slice(0, separatorIndex), dial.slice(separatorIndex + 1));
}

function splitHostPort(value) {
  const normalized = String(value || '').trim().replace(/^"|"$/g, '');
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('[')) {
    const stripped = normalized.slice(1);
    const parts = stripped.split(']:');
    if (parts.length !== 2) {
      return null;
    }

    const parsedPort = parsePortValue(parts[1]);
    if (parsedPort == null) {
      return null;
    }

    return {
      host: parts[0],
      port: parsedPort,
    };
  }

  const separatorIndex = normalized.lastIndexOf(':');
  if (separatorIndex <= 0) {
    return null;
  }

  const parsedPort = parsePortValue(normalized.slice(separatorIndex + 1));
  if (parsedPort == null) {
    return null;
  }

  return {
    host: normalized.slice(0, separatorIndex),
    port: parsedPort,
  };
}

function formatHostPort(host, port) {
  const normalized = String(host || '').trim().replace(/^\[/, '').replace(/\]$/, '');
  if (isIpv6Address(normalized)) {
    return `[${normalized}]:${port}`;
  }
  return `${normalized}:${port}`;
}

function updateAddressPort(value, fallbackHost, port) {
  const current = splitHostPort(value);
  const host = current?.host || fallbackHost;
  return formatHostPort(host, port);
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlArray(values) {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sectionPattern(sectionName) {
  return new RegExp(`(^\\[${escapeRegExp(sectionName)}\\]\\n)([\\s\\S]*?)(?=^\\[|\\Z)`, 'm');
}

function readSectionValue(contents, sectionName, key) {
  const match = String(contents || '').match(sectionPattern(sectionName));
  if (!match) {
    return null;
  }

  const body = match[2];
  const keyMatch = body.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(.+)$`, 'm'));
  return keyMatch ? keyMatch[1].trim() : null;
}

function replaceSectionValue(contents, sectionName, key, rawValue) {
  const pattern = sectionPattern(sectionName);
  const keyPattern = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*.+$`, 'm');

  if (!pattern.test(contents)) {
    return contents;
  }

  return contents.replace(pattern, (fullMatch, header, body) => {
    const normalizedBody = keyPattern.test(body)
      ? body.replace(keyPattern, `${key} = ${rawValue}`)
      : `${body.trimEnd()}\n${key} = ${rawValue}\n`;

    return `${header}${normalizedBody}`;
  });
}

function resolveConfigPath(node, fileName) {
  const configPaths = Array.isArray(node?.config_paths) ? node.config_paths : [];
  return configPaths.find((entry) => {
    const normalized = String(entry || '').replace(/\\/g, '/');
    return normalized.endsWith(`/${fileName}`);
  }) || null;
}

function seedServerUrls(networkProfile) {
  const seeds = Array.isArray(networkProfile?.seed_servers) ? networkProfile.seed_servers : [];
  return seeds
    .map((seed) => {
      if (typeof seed === 'string') {
        return seed;
      }

      if (seed?.url) {
        return seed.url;
      }

      if (seed?.host && seed?.port) {
        return `http://${seed.host}:${seed.port}`;
      }

      return null;
    })
    .filter(Boolean);
}

export function getTestnetBetaDefaultPortSettings() {
  return cloneDefaultPortSettings();
}

export function getTestnetBetaPortFields() {
  return TESTNET_BETA_PORT_FIELDS.map((field) => ({ ...field }));
}

export function formatPortSettingsForForm(settings) {
  const normalized = normalizeStoredPortSettings(settings);
  return Object.fromEntries(
    TESTNET_BETA_PORT_FIELDS.map(({ key }) => [key, String(normalized[key])]),
  );
}

export function formatPortSettingsSummary(settings) {
  const normalized = normalizeStoredPortSettings(settings);
  return `P2P ${normalized.p2p} | RPC ${normalized.rpc} | WS ${normalized.ws} | Discovery ${normalized.discovery} | Metrics ${normalized.metrics}`;
}

export function readStoredTestnetBetaPortSettings() {
  const storage = getLocalStorage();
  if (!storage) {
    return cloneDefaultPortSettings();
  }

  try {
    const raw = storage.getItem(PORT_SETTINGS_STORAGE_KEY);
    return normalizeStoredPortSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return cloneDefaultPortSettings();
  }
}

export function saveStoredTestnetBetaPortSettings(settings) {
  const normalized = normalizeStoredPortSettings(settings);
  const storage = getLocalStorage();
  if (storage) {
    storage.setItem(PORT_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

export function resetStoredTestnetBetaPortSettings() {
  const defaults = cloneDefaultPortSettings();
  const storage = getLocalStorage();
  if (storage) {
    storage.removeItem(PORT_SETTINGS_STORAGE_KEY);
  }
  return defaults;
}

export function validateTestnetBetaPortSettingsForm(formState) {
  const nextValue = {};
  const errors = {};
  const seenPorts = new Map();

  TESTNET_BETA_PORT_FIELDS.forEach(({ key, label }) => {
    const parsed = parsePortValue(formState?.[key]);
    if (parsed == null) {
      errors[key] = `${label} port must be between 1 and 65535.`;
      return;
    }

    nextValue[key] = parsed;
    const previousKey = seenPorts.get(parsed);
    if (previousKey) {
      errors[key] = `${label} port duplicates ${previousKey}.`;
      if (!errors[previousKey]) {
        errors[previousKey] = `${previousKey} duplicates ${label}.`;
      }
      return;
    }

    seenPorts.set(parsed, label);
  });

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: Object.keys(errors).length === 0 ? nextValue : null,
  };
}

export function parseDialAddress(value) {
  let raw = String(value || '').trim();
  if (!raw) {
    return null;
  }

  raw = raw.replace(/^(snr|enode):\/\//i, '');
  if (raw.includes('@')) {
    raw = raw.split('@').pop() || '';
  }

  raw = raw.split('/')[0] || '';
  raw = raw.split('?')[0] || '';
  raw = raw.split('#')[0] || '';

  return normalizeDialTarget(raw.trim());
}

export function normalizeDialTargets(values = []) {
  const deduped = new Set();
  (Array.isArray(values) ? values : []).forEach((value) => {
    const normalized = parseDialAddress(value);
    if (normalized) {
      deduped.add(normalized);
    }
  });
  return Array.from(deduped).sort();
}

export function resolveNodeTomlPath(node) {
  return resolveConfigPath(node, 'node.toml');
}

export function resolvePeersTomlPath(node) {
  return resolveConfigPath(node, 'peers.toml');
}

export function buildPeersToml(networkProfile, additionalDialTargets = []) {
  const bootnodes = (Array.isArray(networkProfile?.bootnodes) ? networkProfile.bootnodes : [])
    .map((entry) => `${entry.host}:${entry.port}`);
  const seeds = seedServerUrls(networkProfile).map((entry) => {
    const trimmed = String(entry).trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  });
  const dialTargets = normalizeDialTargets(additionalDialTargets);

  return `# Testnet-Beta multi-source bootstrap inputs.
# Nodes consume these endpoints directly for hardcoded bootnode dialing, dnsaddr resolution, and seed-service fallbacks.
[global]
bootnodes = ${tomlArray(bootnodes)}
seed_servers = ${tomlArray(seeds)}
bootstrap_dns_records = ${tomlArray([BOOTSTRAP_DNS_RECORD])}
additional_dial_targets = ${tomlArray(dialTargets)}

[testbeta]
core_rpc = ${tomlString(TESTNET_ENDPOINTS.coreRpc)}
core_ws = ${tomlString(TESTNET_ENDPOINTS.coreWs)}
wallet_api = ${tomlString(TESTNET_ENDPOINTS.walletApi)}
sxcp_api = ${tomlString(TESTNET_ENDPOINTS.sxcpApi)}

[security]
strict_tls = true
allow_unpinned_dev_endpoints = false
bootstrap_connectivity_required = false
`;
}

export function parseNodePortSettingsFromToml(contents) {
  const p2pPort = parsePortValue(readSectionValue(contents, 'network', 'p2p_port'))
    ?? splitHostPort(readSectionValue(contents, 'p2p', 'listen_address'))?.port
    ?? TESTNET_BETA_DEFAULT_PORT_SETTINGS.p2p;
  const rpcPort = parsePortValue(readSectionValue(contents, 'network', 'rpc_port'))
    ?? parsePortValue(readSectionValue(contents, 'rpc', 'http_port'))
    ?? splitHostPort(readSectionValue(contents, 'rpc', 'bind_address'))?.port
    ?? TESTNET_BETA_DEFAULT_PORT_SETTINGS.rpc;
  const wsPort = parsePortValue(readSectionValue(contents, 'network', 'ws_port'))
    ?? parsePortValue(readSectionValue(contents, 'rpc', 'ws_port'))
    ?? TESTNET_BETA_DEFAULT_PORT_SETTINGS.ws;
  const discoveryPort = parsePortValue(readSectionValue(contents, 'p2p', 'discovery_port'))
    ?? TESTNET_BETA_DEFAULT_PORT_SETTINGS.discovery;
  const metricsPort = splitHostPort(readSectionValue(contents, 'telemetry', 'metrics_bind'))?.port
    ?? TESTNET_BETA_DEFAULT_PORT_SETTINGS.metrics;

  return normalizeStoredPortSettings({
    p2p: p2pPort,
    rpc: rpcPort,
    ws: wsPort,
    discovery: discoveryPort,
    metrics: metricsPort,
  });
}

export async function readTestnetBetaNodePortSettings(node) {
  const nodeTomlPath = resolveNodeTomlPath(node);
  if (!nodeTomlPath) {
    throw new Error('Generated node is missing a node.toml config path.');
  }

  const contents = await readTextFile(nodeTomlPath);
  return {
    nodeTomlPath,
    portSettings: parseNodePortSettingsFromToml(contents),
  };
}

export async function applyTestnetBetaPortSettings(node, settings) {
  const nodeTomlPath = resolveNodeTomlPath(node);
  if (!nodeTomlPath) {
    throw new Error('Generated node is missing a node.toml config path.');
  }

  let contents = await readTextFile(nodeTomlPath);
  const portSettings = normalizeStoredPortSettings(settings);

  const rpcBindAddress = updateAddressPort(
    readSectionValue(contents, 'rpc', 'bind_address'),
    '127.0.0.1',
    portSettings.rpc,
  );
  const networkP2PListen = updateAddressPort(
    readSectionValue(contents, 'network', 'p2p_listen'),
    '0.0.0.0',
    portSettings.p2p,
  );
  const p2pListenAddress = updateAddressPort(
    readSectionValue(contents, 'p2p', 'listen_address'),
    '0.0.0.0',
    portSettings.p2p,
  );
  const currentPublicAddress = splitHostPort(readSectionValue(contents, 'p2p', 'public_address'));
  const publicHost = currentPublicAddress?.host
    || String(node?.public_host || '').trim()
    || '127.0.0.1';
  const publicAddress = formatHostPort(publicHost, portSettings.p2p);
  const metricsBind = updateAddressPort(
    readSectionValue(contents, 'telemetry', 'metrics_bind'),
    '127.0.0.1',
    portSettings.metrics,
  );

  contents = replaceSectionValue(contents, 'network', 'p2p_port', String(portSettings.p2p));
  contents = replaceSectionValue(contents, 'network', 'rpc_port', String(portSettings.rpc));
  contents = replaceSectionValue(contents, 'network', 'ws_port', String(portSettings.ws));
  contents = replaceSectionValue(contents, 'network', 'p2p_listen', tomlString(networkP2PListen));
  contents = replaceSectionValue(contents, 'rpc', 'bind_address', tomlString(rpcBindAddress));
  contents = replaceSectionValue(contents, 'rpc', 'http_port', String(portSettings.rpc));
  contents = replaceSectionValue(contents, 'rpc', 'ws_port', String(portSettings.ws));
  contents = replaceSectionValue(contents, 'rpc', 'grpc_port', String(portSettings.rpc));
  contents = replaceSectionValue(contents, 'p2p', 'listen_address', tomlString(p2pListenAddress));
  contents = replaceSectionValue(contents, 'p2p', 'public_address', tomlString(publicAddress));
  contents = replaceSectionValue(contents, 'p2p', 'discovery_port', String(portSettings.discovery));
  contents = replaceSectionValue(contents, 'telemetry', 'metrics_bind', tomlString(metricsBind));

  await writeTextFile(nodeTomlPath, contents);

  return {
    nodeTomlPath,
    portSettings,
  };
}

export async function applyStoredTestnetBetaPortSettings(node) {
  return applyTestnetBetaPortSettings(node, readStoredTestnetBetaPortSettings());
}

export async function refreshTestnetBetaBootstrapConfig(node, networkProfile) {
  const peersTomlPath = resolvePeersTomlPath(node);
  if (!peersTomlPath) {
    throw new Error('Generated node is missing a peers.toml config path.');
  }

  const activePorts = await readTestnetBetaNodePortSettings(node)
    .then((result) => result.portSettings)
    .catch(() => readStoredTestnetBetaPortSettings());

  const { targets = [], failures = [] } = await fetchSeedPeerTargets(seedServerUrls(networkProfile));
  const bootnodeTargets = new Set(
    normalizeDialTargets(
      (Array.isArray(networkProfile?.bootnodes) ? networkProfile.bootnodes : []).map(
        (entry) => `${entry.host}:${entry.port}`,
      ),
    ),
  );
  const selfTargets = new Set(
    normalizeDialTargets(
      node?.public_host ? [`${node.public_host}:${activePorts.p2p}`] : [],
    ),
  );
  const additionalDialTargets = normalizeDialTargets(targets).filter(
    (target) => !bootnodeTargets.has(target) && !selfTargets.has(target),
  );

  await writeTextFile(peersTomlPath, buildPeersToml(networkProfile, additionalDialTargets));

  return {
    peersTomlPath,
    additionalDialTargets,
    failures,
  };
}
