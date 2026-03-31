import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invoke, showOpenDialog } from '../lib/desktopClient';
import {
  applyStoredTestnetBetaPortSettings,
  formatPortSettingsSummary,
  refreshTestnetBetaBootstrapConfig,
} from '../lib/testnetBetaBootstrap';
import { SNRGButton } from '../styles/SNRGButton';

function createId(prefix = 'item') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function formatClock(value = new Date()) {
  return value.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function truncateAddress(value, visible = 8) {
  const text = String(value || '').trim();
  if (!text || text.length <= visible * 2) return text || 'Pending';
  return `${text.slice(0, visible)}...${text.slice(-visible)}`;
}

function normalizeOutputLines(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function sanitizeSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function isContinueValue(value) {
  return /^(continue|yes|ok|proceed|use default|provision node)$/i.test(String(value || '').trim());
}

function suggestedDirectory(homeDirectory, roleId) {
  const base = String(homeDirectory || '~').replace(/[\\/]+$/, '');
  return `${base}/.synergy/testnet-beta/nodes/${sanitizeSlug(roleId || 'node')}-workspace`;
}

function suggestedCeremonyDirectory(homeDirectory, roleId) {
  const base = String(homeDirectory || '~').replace(/[\\/]+$/, '');
  if (roleId === 'bootnode' || roleId === 'seed_server') {
    return `${base}/.synergy/testnet-beta/ceremony/${sanitizeSlug(roleId)}-bundle`;
  }
  return `${base}/.synergy/testnet-beta/nodes/${sanitizeSlug(roleId || 'node')}-workspace`;
}

function formatStake(value) {
  const text = String(value ?? '').trim();
  if (!text) return '5,000 SNRG';
  const number = Number.parseFloat(text);
  if (!Number.isFinite(number)) return text;
  if (Number.isInteger(number)) return `${number.toLocaleString()} SNRG`;
  return `${number.toLocaleString(undefined, { maximumFractionDigits: 2 })} SNRG`;
}

function deriveSetupStatus(phase, running, hasProvisionedNode) {
  if (phase === 'error') {
    return { label: 'Needs Attention', tone: 'danger' };
  }

  if (running || phase === 'booting') {
    return { label: 'Getting Ready', tone: 'success' };
  }

  if (hasProvisionedNode || phase === 'ready_provision') {
    return { label: 'Ready', tone: 'success' };
  }

  return { label: 'In Progress', tone: 'success' };
}

// Most phases still allow free-form chat input so Jarvis can switch modes
// or accept typed overrides. The package picker is the one stage that is
// intentionally button-driven.
const promptKindsWithSelections = new Set(['select_ceremony_package']);

// Roles that are designed to run on a dedicated public server rather than the
// user's own machine.  For these roles the setup wizard asks for the server IP
// before provisioning so it can be baked into node.toml and nginx.conf.
const REMOTE_DEPLOYMENT_ROLES = new Set(['rpc_gateway', 'indexer']);
const SETUP_ALLOWED_ROLE_IDS = new Set([
  'validator',
  'witness',
  'data_availability',
  'rpc_gateway',
  'indexer',
  'archive_validator',
  'audit_validator',
  'governance_auditor',
  'ai_inference',
  'observer',
]);
const CEREMONY_REMOTE_DEPLOYMENT_ROLES = new Set(['rpc_gateway', 'indexer']);
const CEREMONY_ROLE_OPTIONS = [
  {
    id: 'bootnode',
    display_name: 'Bootnode',
    class_name: 'Bootstrap',
    summary: 'Imports the approved bootstrap-only discovery bundle for one of the three beta bootnodes.',
    responsibilities: [
      'Stage the approved bootnode bundle.',
      'Keep the assigned hostname, IP, and discovery port aligned with the beta manifest.',
      'Run only the bootstrap-only runtime from the imported bundle.',
    ],
    service_surface: ['p2p', 'discovery', 'bootstrap-only'],
    package_hint: 'Select the bootnode bundle archive downloaded from the Genesis Dashboard.',
  },
  {
    id: 'seed_server',
    display_name: 'Seed Server',
    class_name: 'Bootstrap',
    summary: 'Imports the approved peer-registry bundle for one of the three beta seed services.',
    responsibilities: [
      'Stage the approved seed-service bundle.',
      'Publish the signed peer list on the assigned beta hostname and port.',
      'Keep the bootstrap DNS and peer registry aligned with the operational manifest.',
    ],
    service_surface: ['peer-registry', 'http', 'bootstrap-support'],
    package_hint: 'Select the seed-server bundle archive downloaded from the Genesis Dashboard.',
  },
  {
    id: 'validator',
    display_name: 'Genesis Validator Node',
    class_name: 'Consensus',
    summary: 'Imports the approved validator ceremony package and provisions the runtime workspace with the assigned validator identity.',
    responsibilities: [
      'Load the assigned validator ceremony package.',
      'Provision the workspace with the approved validator identity and canonical beta manifests.',
      'Start only after the canonical launch data is present in the workspace.',
    ],
    service_surface: ['p2p', 'consensus', 'wallet', 'telemetry'],
    package_hint: 'Select the validator ceremony package downloaded from the Genesis Dashboard.',
  },
  {
    id: 'rpc_gateway',
    display_name: 'RPC Gateway Node',
    class_name: 'Service / Access',
    summary: 'Imports the public RPC gateway package and provisions the read-only public RPC surface for beta.',
    responsibilities: [
      'Load the approved RPC gateway package.',
      'Provision nginx and runtime config for the canonical beta RPC and WS endpoints.',
      'Keep signing keys off the public gateway host.',
    ],
    service_surface: ['rpc', 'ws', 'gateway', 'nginx'],
    package_hint: 'Select the RPC gateway package downloaded from the Genesis Dashboard.',
  },
  {
    id: 'indexer',
    display_name: 'Indexer & Explorer Node',
    class_name: 'Service / Access',
    summary: 'Imports the explorer/indexer package and provisions the beta ingest and query workspace.',
    responsibilities: [
      'Load the approved explorer/indexer package.',
      'Keep ingest and query services aligned with the canonical beta manifests.',
      'Remain non-authoritative while indexing the live beta chain.',
    ],
    service_surface: ['indexer', 'query-api', 'explorer'],
    package_hint: 'Select the explorer/indexer package downloaded from the Genesis Dashboard.',
  },
];

function TestnetBetaJarvisSetup({ onComplete, onDefer }) {
  const initializedRef = useRef(false);
  const messagesEndRef = useRef(null);
  const terminalScrollRef = useRef(null);
  const messageQueueRef = useRef(Promise.resolve());
  const conversationEpochRef = useRef(0);
  const navigate = useNavigate();

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState('booting');
  const [setupMode, setSetupMode] = useState('standard');
  const [running, setRunning] = useState(false);
  const [typing, setTyping] = useState(false);
  const [shellReady, setShellReady] = useState(false);
  const [selectValue, setSelectValue] = useState('');

  const [deviceProfile, setDeviceProfile] = useState(null);
  const [networkProfile, setNetworkProfile] = useState(null);
  const [nodeCatalog, setNodeCatalog] = useState([]);
  const [existingNodes, setExistingNodes] = useState([]);

  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [publicHost, setPublicHost] = useState('');
  const [directoryChoice, setDirectoryChoice] = useState('');
  const [provisionResult, setProvisionResult] = useState(null);
  const [ceremonyPackagePath, setCeremonyPackagePath] = useState('');
  const [ceremonyImportResult, setCeremonyImportResult] = useState(null);

  const [terminalCwd, setTerminalCwd] = useState('');
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalLines, setTerminalLines] = useState([]);

  const activeRoleCatalog = useMemo(
    () => (setupMode === 'ceremony' ? CEREMONY_ROLE_OPTIONS : nodeCatalog),
    [nodeCatalog, setupMode],
  );
  const selectedRole = useMemo(
    () => activeRoleCatalog.find((entry) => entry.id === selectedRoleId) || null,
    [activeRoleCatalog, selectedRoleId],
  );
  const setupStatus = useMemo(
    () => deriveSetupStatus(phase, running, Boolean(provisionResult?.node || ceremonyImportResult?.node)),
    [ceremonyImportResult?.node, phase, provisionResult?.node, running],
  );
  const chatInputLocked = useMemo(
    () => running || phase === 'booting' || promptKindsWithSelections.has(phase),
    [phase, running],
  );

  const statusItems = useMemo(() => ([
    { label: 'Environment', value: networkProfile?.display_name || TESTNET_FALLBACK_DISPLAY },
    { label: 'Detected host', value: deviceProfile?.hostname || 'Detecting...' },
    { label: 'Setup mode', value: setupMode === 'ceremony' ? 'Genesis import' : 'Standard setup' },
    { label: 'Provisioned nodes', value: existingNodes.length ? String(existingNodes.length) : '0' },
    { label: 'Selected node type', value: selectedRole?.display_name || 'Awaiting selection' },
  ]), [deviceProfile?.hostname, existingNodes.length, networkProfile?.display_name, selectedRole?.display_name, setupMode]);

  const networkBootnodes = networkProfile?.bootnodes || [];
  const networkSeeds = networkProfile?.seed_servers || [];

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setShellReady(true);
    }, 100);

    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, typing]);

  useEffect(() => {
    terminalScrollRef.current?.scrollTo({
      top: terminalScrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [terminalLines]);

  const resetMessageQueue = useCallback(() => {
    conversationEpochRef.current += 1;
    messageQueueRef.current = Promise.resolve();
    setTyping(false);
  }, []);

  const addMessage = useCallback((sender, text, type = 'text') => {
    setMessages((prev) => [
      ...prev,
      { id: createId('message'), sender, text, type },
    ]);
  }, []);

  const addTerminalLine = useCallback((kind, text) => {
    const lines = Array.isArray(text) ? text : [text];
    const nextLines = lines
      .map((line) => String(line || '').trimEnd())
      .filter(Boolean)
      .map((line) => ({
        id: createId('terminal'),
        kind,
        text: line,
        at: formatClock(),
      }));

    if (!nextLines.length) return;
    setTerminalLines((prev) => [...prev, ...nextLines]);
  }, []);

  const queueJarvisMessage = useCallback((text, type = 'text', options = {}) => {
    const messageText = String(text || '').trim();
    if (!messageText) return Promise.resolve();

    const epoch = conversationEpochRef.current;
    const typingMs = options.instant ? 0 : options.typingMs ?? Math.min(1450, 340 + messageText.length * 11);
    const pauseMs = options.pauseMs ?? 180;

    const job = async () => {
      if (epoch !== conversationEpochRef.current) return;

      if (typingMs > 0) {
        setTyping(true);
        await sleep(typingMs);
      }

      if (epoch !== conversationEpochRef.current) {
        setTyping(false);
        return;
      }

      setTyping(false);
      addMessage('jarvis', messageText, type);

      if (pauseMs > 0) {
        await sleep(pauseMs);
      }
    };

    messageQueueRef.current = messageQueueRef.current.then(job, job);
    return messageQueueRef.current;
  }, [addMessage]);

  const queueJarvisMessages = useCallback(async (items) => {
    for (const item of items) {
      await queueJarvisMessage(item.text, item.type || 'text', item);
    }
  }, [queueJarvisMessage]);

  const detectPublicHost = useCallback(async () => {
    const candidates = [
      'https://api64.ipify.org?format=text',
      'https://api.ipify.org?format=text',
    ];

    for (const endpoint of candidates) {
      try {
        const response = await fetch(endpoint, { cache: 'no-store' });
        if (!response.ok) continue;
        const value = (await response.text()).trim();
        if (value) return value;
      } catch {
        // Try the next endpoint.
      }
    }

    return '';
  }, []);

  const refreshPublicHost = useCallback(async ({ announce = false } = {}) => {
    const resolved = await detectPublicHost();
    setPublicHost(resolved);
    if (announce) {
      if (resolved) {
        addTerminalLine('info', `Detected public endpoint: ${resolved}`);
      } else {
        addTerminalLine('warning', 'Public endpoint auto-detection did not return a value.');
      }
    }
    return resolved;
  }, [addTerminalLine, detectPublicHost]);

  const executeCommandAndLog = useCallback(async (command, cwdOverride = null) => {
    const effectiveCwd = cwdOverride || terminalCwd || deviceProfile?.home_directory || null;
    const promptPrefix = effectiveCwd || '~';
    addTerminalLine('prompt', `${promptPrefix} $ ${command}`);

    const result = await invoke('monitor_run_terminal_command', {
      command,
      cwd: effectiveCwd,
    });

    if (result?.cwd) {
      setTerminalCwd(String(result.cwd));
    }

    normalizeOutputLines(result?.stdout).forEach((line) => addTerminalLine('output', line));
    normalizeOutputLines(result?.stderr).forEach((line) => addTerminalLine('error', line));
    return result;
  }, [addTerminalLine, deviceProfile?.home_directory, terminalCwd]);

  const runTerminalCommand = useCallback(async (rawCommand) => {
    const command = String(rawCommand || '').trim();
    if (!command || terminalBusy) return;

    setTerminalBusy(true);
    try {
      const result = await executeCommandAndLog(command);
      if (!result?.success && normalizeOutputLines(result?.stderr).length === 0) {
        addTerminalLine('error', `Command failed with exit code ${result?.exit_code ?? 'unknown'}`);
      }
    } catch (error) {
      addTerminalLine('error', String(error));
    } finally {
      setTerminalBusy(false);
    }
  }, [addTerminalLine, executeCommandAndLog, terminalBusy]);

  const submitTerminal = useCallback(async (event) => {
    event.preventDefault();
    const command = terminalInput.trim();
    if (!command) return;
    setTerminalInput('');
    await runTerminalCommand(command);
  }, [runTerminalCommand, terminalInput]);

  const handoffToDashboard = useCallback(async () => {
    resetMessageQueue();
    await queueJarvisMessages([
      {
        text: 'No problem.',
        typingMs: 420,
        pauseMs: 220,
      },
      {
        text: 'I am returning you to the main control panel. You can come back to setup whenever you are ready.',
        typingMs: 820,
      },
    ]);

    if (typeof onDefer === 'function') {
      onDefer();
    } else if (typeof onComplete === 'function') {
      onComplete();
    }
    navigate('/');
  }, [navigate, onComplete, onDefer, queueJarvisMessages, resetMessageQueue]);

  const refreshState = useCallback(async (announce = false) => {
    const data = await invoke('testbeta_get_state');
    setDeviceProfile(data?.device_profile || null);
    setNetworkProfile(data?.network_profile || null);
    setNodeCatalog(
      (Array.isArray(data?.node_catalog) ? data.node_catalog : [])
        .filter((entry) => SETUP_ALLOWED_ROLE_IDS.has(String(entry?.id || '').trim())),
    );
    setExistingNodes(Array.isArray(data?.nodes) ? data.nodes : []);
    setTerminalCwd(data?.device_profile?.home_directory || '');

    if (announce) {
      addTerminalLine('info', `Device profile refreshed for ${data?.device_profile?.hostname || 'unknown host'}`);
      await queueJarvisMessage('I checked this computer again and refreshed the setup details.');
    }

    return data;
  }, [addTerminalLine, queueJarvisMessage]);

  const bootstrap = useCallback(async () => {
    setRunning(true);
    addTerminalLine('info', 'Loading the Testnet-Beta node catalog and local device profile...');
    try {
      await queueJarvisMessages([
        {
          text: 'Hello, and welcome.',
          typingMs: 480,
          pauseMs: 220,
        },
        {
          text: 'I am Jarvis, your setup assistant.',
          typingMs: 620,
          pauseMs: 240,
        },
      ]);

      await refreshState(false);

      await queueJarvisMessages([
        {
          text: 'I will help you set up a Synergy node on this computer.',
          typingMs: 740,
          pauseMs: 240,
        },
        {
          text: 'I will ask a few simple questions, create a private folder for the node, and prepare the control panel for it.',
          typingMs: 960,
          pauseMs: 260,
        },
      ]);

      await refreshPublicHost({ announce: true });
      setPhase('await_node_type');
    } catch (error) {
      addTerminalLine('error', `Failed to initialize Testnet-Beta setup: ${String(error)}`);
      await queueJarvisMessages([
        {
          text: 'I ran into a problem while getting setup ready.',
          typingMs: 640,
          pauseMs: 220,
        },
        {
          text: 'You can restart setup once the issue is cleared.',
          typingMs: 820,
        },
      ]);
      setPhase('error');
    } finally {
      setRunning(false);
    }
  }, [addTerminalLine, queueJarvisMessages, refreshState]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    bootstrap();
  }, [bootstrap]);

  const selectCeremonyPackage = useCallback(async () => {
    try {
      const selectedPath = await showOpenDialog({
        title: 'Select Genesis Ceremony Package',
        buttonLabel: 'Select Package',
        properties: ['openFile', 'openDirectory'],
        filters: [
          { name: 'Ceremony Packages', extensions: ['json', 'zip', 'tgz', 'gz'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (!selectedPath) {
        return;
      }

      setCeremonyPackagePath(selectedPath);
      addTerminalLine('info', `Selected ceremony package: ${selectedPath}`);
      await queueJarvisMessage(`Package selected: ${selectedPath}. Choose Import Package when you are ready.`);
    } catch (error) {
      addTerminalLine('error', `Package selection failed: ${String(error)}`);
      await queueJarvisMessage('I could not open the package selector on this machine.');
    }
  }, [addTerminalLine, queueJarvisMessage]);

  const runCeremonyImport = useCallback(async () => {
    if (!selectedRole) {
      await queueJarvisMessage('Choose the ceremony role for this machine before importing a package.');
      return;
    }

    if (!ceremonyPackagePath) {
      await queueJarvisMessage('Select the approved ceremony package from the Genesis Dashboard first.');
      return;
    }

    setRunning(true);
    addTerminalLine('info', `Importing ${selectedRole.display_name} from ${ceremonyPackagePath}...`);

    try {
      const result = await invoke('testbeta_import_ceremony_package', {
        input: {
          setupRoleId: selectedRole.id,
          packagePath: ceremonyPackagePath,
          intendedDirectory: directoryChoice || null,
          publicHost: publicHost || null,
        },
      });

      setCeremonyImportResult(result);
      if (result?.node) {
        setProvisionResult({
          node: result.node,
          network_profile: result.network_profile || null,
        });
      }
      setTerminalCwd(result?.workspace_directory || terminalCwd);
      addTerminalLine('success', result?.message || 'Ceremony package imported.');
      (result?.staged_paths || []).forEach((path) => addTerminalLine('output', `Staged: ${path}`));

      if (result?.node) {
        addTerminalLine('output', `Reward wallet: ${result?.node?.node_address || 'unknown address'}`);
        addTerminalLine('info', `Funding manifest: ${result?.node?.funding_manifest_id || 'pending'}`);
        try {
          const portConfig = await applyStoredTestnetBetaPortSettings(result?.node);
          addTerminalLine(
            'info',
            `Electron wrote node.toml port profile: ${formatPortSettingsSummary(portConfig.portSettings)}.`,
          );
        } catch (portError) {
          addTerminalLine('info', `Electron port profile update skipped: ${String(portError)}`);
        }
        try {
          const bootstrapConfig = await refreshTestnetBetaBootstrapConfig(
            result?.node,
            result?.network_profile,
          );
          addTerminalLine(
            'info',
            `Electron refreshed peers.toml with ${bootstrapConfig.additionalDialTargets.length} seed-discovered dial target(s).`,
          );
          if (bootstrapConfig.failures.length > 0) {
            addTerminalLine('info', `Seed preload warnings: ${bootstrapConfig.failures.join(' | ')}`);
          }
        } catch (bootstrapError) {
          addTerminalLine('info', `Electron bootstrap refresh skipped: ${String(bootstrapError)}`);
        }

        addTerminalLine('info', 'Starting the imported node runtime and joining the bootstrap network...');
        const startResult = await invoke('testbeta_node_control', {
          input: {
            nodeId: result?.node?.id,
            action: 'start',
          },
        });
        addTerminalLine('success', startResult?.message || 'Imported node runtime started.');

        await queueJarvisMessages([
          {
            text: `${selectedRole.display_name} import is complete.`,
            typingMs: 700,
            pauseMs: 220,
          },
          {
            text: 'I staged the approved package, applied the canonical beta manifests, and started the node runtime for this role.',
            typingMs: 1060,
          },
        ]);

        await refreshState(false);
        if (typeof onComplete === 'function') {
          onComplete();
        }
        navigate('/');
        return;
      }

      await queueJarvisMessages([
        {
          text: `${selectedRole.display_name} package import is complete.`,
          typingMs: 720,
          pauseMs: 220,
        },
        {
          text: result?.message || 'The approved bundle is staged and ready for the assigned beta host.',
          typingMs: 1040,
        },
      ]);
    } catch (error) {
      addTerminalLine('error', `Ceremony import failed: ${String(error)}`);
      await queueJarvisMessages([
        {
          text: 'I hit a problem while importing the approved ceremony package.',
          typingMs: 760,
          pauseMs: 220,
        },
        {
          text: 'You can select the package again, choose a different folder, or restart setup.',
          typingMs: 980,
        },
      ]);
      setPhase('error');
    } finally {
      setRunning(false);
    }
  }, [
    addTerminalLine,
    ceremonyPackagePath,
    directoryChoice,
    navigate,
    onComplete,
    publicHost,
    queueJarvisMessage,
    queueJarvisMessages,
    refreshState,
    selectedRole,
    terminalCwd,
  ]);

  const runProvision = useCallback(async () => {
    if (!selectedRole) {
      await queueJarvisMessage('Select a node role before provisioning.');
      return;
    }

    setRunning(true);
    addTerminalLine('info', `Provisioning ${selectedRole.display_name} in an isolated Testnet-Beta workspace...`);
    addTerminalLine('info', 'Provisioning started with role-validated runtime and bootstrap configuration.');

    try {
      const result = await invoke('testbeta_setup_node', {
        input: {
          roleId: selectedRole.id,
          displayLabel: selectedRole.display_name,
          intendedDirectory: directoryChoice || null,
          publicHost: publicHost || null,
        },
      });

      setProvisionResult(result);
      setTerminalCwd(result?.node?.workspace_directory || terminalCwd);
      addTerminalLine('success', `Workspace created: ${result?.node?.workspace_directory || 'unknown path'}`);
      (result?.node?.config_paths || []).forEach((path) => addTerminalLine('output', `Generated: ${path}`));
      addTerminalLine('output', `Reward wallet: ${result?.node?.node_address || 'unknown address'}`);
      addTerminalLine('info', `Funding manifest: ${result?.node?.funding_manifest_id || 'pending'}`);
      try {
        const portConfig = await applyStoredTestnetBetaPortSettings(result?.node);
        addTerminalLine(
          'info',
          `Electron wrote node.toml port profile: ${formatPortSettingsSummary(portConfig.portSettings)}.`,
        );
      } catch (portError) {
        addTerminalLine('info', `Electron port profile update skipped: ${String(portError)}`);
      }
      try {
        const bootstrapConfig = await refreshTestnetBetaBootstrapConfig(
          result?.node,
          result?.network_profile,
        );
        addTerminalLine(
          'info',
          `Electron refreshed peers.toml with ${bootstrapConfig.additionalDialTargets.length} seed-discovered dial target(s).`,
        );
        if (bootstrapConfig.failures.length > 0) {
          addTerminalLine(
            'info',
            `Seed preload warnings: ${bootstrapConfig.failures.join(' | ')}`,
          );
        }
      } catch (bootstrapError) {
        addTerminalLine(
          'info',
          `Electron bootstrap refresh skipped: ${String(bootstrapError)}`,
        );
      }
      addTerminalLine('info', 'Starting the role-bound node runtime and joining the bootstrap network...');

      const startResult = await invoke('testbeta_node_control', {
        input: {
          nodeId: result?.node?.id,
          action: 'start',
        },
      });
      addTerminalLine('success', startResult?.message || 'Node runtime started.');

      await queueJarvisMessages([
        {
          text: `${selectedRole.display_name} is ready.`,
          typingMs: 620,
          pauseMs: 220,
        },
        {
          text: 'I created the private workspace, prepared the node wallet, and started the node runtime. It is now discovering peers and syncing chain data.',
          typingMs: 980,
        },
      ]);

      await refreshState(false);
      if (typeof onComplete === 'function') {
        onComplete();
      }
      navigate('/');
    } catch (error) {
      addTerminalLine('error', `Provisioning failed: ${String(error)}`);
      await queueJarvisMessages([
        {
          text: 'I hit a problem before setup could finish.',
          typingMs: 620,
          pauseMs: 220,
        },
        {
          text: 'You can restart setup once the issue is cleared.',
          typingMs: 820,
        },
      ]);
      setPhase('error');
    } finally {
      setRunning(false);
    }
  }, [
    directoryChoice,
    navigate,
    onComplete,
    publicHost,
    queueJarvisMessage,
    queueJarvisMessages,
    refreshState,
    selectedRole,
    terminalCwd,
  ]);

  const handleResponseValue = useCallback(async (value) => {
    if (!value || running) return;

    const trimmedValue = String(value).trim();

    if (/^(dashboard|not now jarvis|not now|later)$/i.test(trimmedValue)) {
      await handoffToDashboard();
      return;
    }

    if (/^genesis[\s-]*setup$/i.test(trimmedValue)) {
      resetMessageQueue();
      setSetupMode('ceremony');
      setSelectedRoleId('');
      setPublicHost('');
      setDirectoryChoice('');
      setProvisionResult(null);
      setCeremonyPackagePath('');
      setCeremonyImportResult(null);
      setRunning(true);
      try {
        await refreshState(false);
      } finally {
        setRunning(false);
      }
      await queueJarvisMessages([
        {
          text: 'Genesis setup mode is active.',
          typingMs: 620,
          pauseMs: 220,
        },
        {
          text: 'Choose the ceremony role for this machine and I will import the approved package from the Genesis Dashboard into a Control Panel-managed workspace.',
          typingMs: 1040,
        },
      ]);
      setPhase('await_ceremony_role');
      return;
    }

    if (/^(restart|start over|reset)$/i.test(trimmedValue)) {
      const nextPhase = setupMode === 'ceremony' ? 'await_ceremony_role' : 'await_node_type';
      resetMessageQueue();
      setSelectedRoleId('');
      setPublicHost('');
      setDirectoryChoice('');
      setProvisionResult(null);
      setCeremonyPackagePath('');
      setCeremonyImportResult(null);
      setPhase(nextPhase);
      await queueJarvisMessage(
        setupMode === 'ceremony'
          ? 'I cleared the previous setup steps. Choose the ceremony role for this machine.'
          : 'I cleared the previous setup steps. Choose the kind of node you want to set up.',
      );
      return;
    }

    if (phase === 'await_node_type') {
      const nextRole = nodeCatalog.find((entry) => entry.id === trimmedValue);
      if (!nextRole) {
        await queueJarvisMessage('Choose one of the node types in the list or type "genesis setup" to switch into ceremony mode.');
        return;
      }

      const nextDirectory = suggestedDirectory(deviceProfile?.home_directory || '~', nextRole.id);
      setSetupMode('standard');
      setSelectedRoleId(nextRole.id);
      setDirectoryChoice(nextDirectory);
      setCeremonyPackagePath('');
      setCeremonyImportResult(null);

      await queueJarvisMessages([
        {
          text: `${nextRole.display_name} selected. I will set this computer up for that job.`,
          typingMs: 760,
          pauseMs: 220,
        },
        {
          text: 'Take a quick look at the computer details on the right. If they look right, continue. If not, refresh and I will check again.',
          typingMs: 1040,
        },
      ]);
      setPhase('review_device');
      return;
    }

    if (phase === 'await_ceremony_role') {
      const nextRole = CEREMONY_ROLE_OPTIONS.find((entry) => entry.id === trimmedValue);
      if (!nextRole) {
        await queueJarvisMessage('Choose one of the ceremony roles in the list and I will load the approved import flow for it.');
        return;
      }

      const nextDirectory = suggestedCeremonyDirectory(deviceProfile?.home_directory || '~', nextRole.id);
      setSelectedRoleId(nextRole.id);
      setDirectoryChoice(nextDirectory);
      setCeremonyPackagePath('');
      setCeremonyImportResult(null);
      setProvisionResult(null);

      await queueJarvisMessages([
        {
          text: `${nextRole.display_name} selected. I will prepare this machine for the approved ceremony package.`,
          typingMs: 820,
          pauseMs: 220,
        },
        {
          text: 'Take a quick look at the computer details on the right. If they look right, continue. If not, refresh and I will check again.',
          typingMs: 1040,
        },
      ]);
      setPhase('review_device');
      return;
    }

    if (phase === 'review_device') {
      if (/^refresh/i.test(trimmedValue)) {
        setRunning(true);
        try {
          await refreshState(true);
        } finally {
          setRunning(false);
        }
        return;
      }

      if (isContinueValue(trimmedValue)) {
        const remoteDeploymentRoles = setupMode === 'ceremony'
          ? CEREMONY_REMOTE_DEPLOYMENT_ROLES
          : REMOTE_DEPLOYMENT_ROLES;

        setRunning(true);
        let detected = '';
        try {
          detected = await refreshPublicHost({ announce: true });
          if (detected) {
            await queueJarvisMessage(`Public endpoint detected as ${detected}.`);
          } else {
            await queueJarvisMessage('I could not auto-detect a public endpoint right now, but setup can continue.');
          }
        } finally {
          setRunning(false);
        }

        if (remoteDeploymentRoles.has(selectedRoleId)) {
          const detectedNote = detected
            ? `I detected this machine's IP as ${detected}.`
            : "I couldn't auto-detect an IP for this machine.";
          await queueJarvisMessage(
            `${detectedNote} This role is built to run on a dedicated public server. ` +
            `Enter that server's IP address now (e.g. 74.208.227.23), or choose "Use Detected" to keep the value above.`,
          );
          setPhase(setupMode === 'ceremony' ? 'confirm_ceremony_public_host' : 'confirm_public_host');
        } else {
          await queueJarvisMessage(
            `The private folder I plan to use is ${directoryChoice}. Type "use default" to keep it, or paste a different folder path.`,
          );
          setPhase(setupMode === 'ceremony' ? 'review_ceremony_directory' : 'review_directory');
        }
        return;
      }

      await queueJarvisMessage('Choose Continue if these details look right, or Refresh Detection if you want me to check again.');
      return;
    }

    if (phase === 'confirm_public_host' || phase === 'confirm_ceremony_public_host') {
      if (!/^use[\s-]*detected$/i.test(trimmedValue) && trimmedValue) {
        setPublicHost(trimmedValue);
        await queueJarvisMessage(`Server IP set to ${trimmedValue}. This will be written into the runtime config for this node.`);
      } else {
        await queueJarvisMessage(
          publicHost
            ? `Using auto-detected IP: ${publicHost}.`
            : 'No IP available. You can update the runtime config manually after setup.',
        );
      }
      await queueJarvisMessage(
        `The private folder I plan to use is ${directoryChoice}. Type "use default" to keep it, or paste a different folder path.`,
      );
      setPhase(phase === 'confirm_ceremony_public_host' ? 'review_ceremony_directory' : 'review_directory');
      return;
    }

    if (phase === 'review_directory') {
      if (!isContinueValue(trimmedValue) && trimmedValue) {
        if (/^auto[\s-]*detect$/i.test(trimmedValue)) {
          setRunning(true);
          try {
            const detected = await refreshPublicHost({ announce: true });
            await queueJarvisMessage(
              detected
                ? `Updated public endpoint: ${detected}.`
                : 'Public endpoint is still unavailable. Continuing without it.',
            );
          } finally {
            setRunning(false);
          }
        } else {
          setDirectoryChoice(trimmedValue);
        }
      }
      await queueJarvisMessage('Everything is ready. I will create the private folder, generate the node wallet, write the setup files, and prepare the required 5,000 SNRG stake for this node.');
      setPhase('ready_provision');
      return;
    }

    if (phase === 'review_ceremony_directory') {
      if (!isContinueValue(trimmedValue) && trimmedValue) {
        if (/^auto[\s-]*detect$/i.test(trimmedValue)) {
          setRunning(true);
          try {
            const detected = await refreshPublicHost({ announce: true });
            await queueJarvisMessage(
              detected
                ? `Updated public endpoint: ${detected}.`
                : 'Public endpoint is still unavailable. Continuing without it.',
            );
          } finally {
            setRunning(false);
          }
        } else {
          setDirectoryChoice(trimmedValue);
        }
      }
      await queueJarvisMessage(
        selectedRole?.package_hint
          || 'Select the approved ceremony package from the Genesis Dashboard, then import it into this Control Panel workspace.',
      );
      setPhase('select_ceremony_package');
      return;
    }

    if (phase === 'select_ceremony_package') {
      if (/^select/i.test(trimmedValue)) {
        await selectCeremonyPackage();
        return;
      }
      if (/^import/i.test(trimmedValue)) {
        await runCeremonyImport();
        return;
      }
      await queueJarvisMessage('Use Select Package to choose the approved file or folder, then choose Import Package.');
      return;
    }

    if (phase === 'ready_provision') {
      if (isContinueValue(trimmedValue)) {
        await runProvision();
        return;
      }

      await queueJarvisMessage('Choose Provision Node when you are ready.');
      return;
    }

    if (phase === 'error') {
      await queueJarvisMessage('Type restart to try setup again, say "genesis setup" to switch into ceremony mode, or say "not now jarvis" and I will take you to the dashboard.');
    }
  }, [
    deviceProfile?.home_directory,
    directoryChoice,
    handoffToDashboard,
    nodeCatalog,
    phase,
    publicHost,
    queueJarvisMessage,
    queueJarvisMessages,
    refreshPublicHost,
    refreshState,
    resetMessageQueue,
    runCeremonyImport,
    runProvision,
    running,
    selectCeremonyPackage,
    selectedRole?.package_hint,
    selectedRoleId,
    setupMode,
  ]);

  const submitChat = useCallback(async (event) => {
    event.preventDefault();
    const value = input.trim();
    if (!value || running || phase === 'booting') return;

    addMessage('user', value);
    setInput('');
    await handleResponseValue(value);
  }, [addMessage, handleResponseValue, input, phase, running]);

  const submitChoice = useCallback(async (value, displayLabel = value) => {
    if (!value || running) return;
    addMessage('user', displayLabel);
    await handleResponseValue(value);
  }, [addMessage, handleResponseValue, running]);

  const submitSelect = useCallback(async (event) => {
    event.preventDefault();
    if (!selectValue || running) return;

    const label = activeRoleCatalog.find((entry) => entry.id === selectValue)?.display_name || selectValue;
    addMessage('user', label);
    await handleResponseValue(selectValue);
  }, [activeRoleCatalog, addMessage, handleResponseValue, running, selectValue]);

  const promptConfig = useMemo(() => {
    if (phase === 'await_node_type') {
      return {
        kind: 'select',
        hint: '',
        options: nodeCatalog.map((entry) => ({
          value: entry.id,
          label: `${entry.display_name} / ${entry.class_name}`,
        })),
        placeholder: 'Choose a node type to continue',
      };
    }

    if (phase === 'await_ceremony_role') {
      return {
        kind: 'select',
        hint: '',
        options: CEREMONY_ROLE_OPTIONS.map((entry) => ({
          value: entry.id,
          label: `${entry.display_name} / ${entry.class_name}`,
        })),
        placeholder: 'Choose a ceremony role to continue',
      };
    }

    if (phase === 'review_device') {
      return {
        kind: 'choices',
        hint: 'If these computer details look right, continue. If not, refresh the scan.',
        options: [
          { value: 'continue', label: 'Continue' },
          { value: 'refresh detection', label: 'Refresh Detection' },
        ],
        placeholder: 'Type your reply here',
      };
    }

    if (phase === 'confirm_public_host' || phase === 'confirm_ceremony_public_host') {
      return {
        kind: 'choices',
        hint: publicHost
          ? `Detected IP: ${publicHost}. Enter a different server IP, or choose "Use Detected" to keep it.`
          : 'Enter the public IP address of the server this node will run on.',
        options: [
          {
            value: 'use detected',
            label: publicHost ? `Use Detected (${publicHost})` : 'Use Detected',
          },
        ],
        placeholder: 'Enter server IP (e.g. 74.208.227.23) or use detected',
      };
    }

    if (phase === 'review_directory') {
      return {
        kind: 'choices',
        hint: `Private folder path: ${directoryChoice}. You can paste a custom path or use this one.`,
        options: [
          { value: 'use default', label: 'Use This Folder' },
        ],
        placeholder: 'Paste a different folder path or use this one',
      };
    }

    if (phase === 'review_ceremony_directory') {
      return {
        kind: 'choices',
        hint: `Control Panel workspace path: ${directoryChoice}. Genesis Setup manages this runtime itself, so do not run a separate launchd or systemd validator on the same machine.`,
        options: [
          { value: 'use default', label: 'Use This Folder' },
        ],
        placeholder: 'Paste a different folder path or use this one',
      };
    }

    if (phase === 'select_ceremony_package') {
      return {
        kind: 'package',
        hint: selectedRole?.package_hint || 'Select the approved ceremony package from the Genesis Dashboard.',
        packagePath: ceremonyPackagePath,
        placeholder: 'Use the package controls below',
      };
    }

    if (phase === 'ready_provision') {
      return {
        kind: 'choices',
        hint: 'Start setup now.',
        options: [
          { value: 'provision node', label: 'Provision Node' },
        ],
        placeholder: 'Type your reply here',
      };
    }

    if (phase === 'error') {
      return {
        kind: 'choices',
        hint: 'Setup needs attention. Restart the setup sequence to continue.',
        options: [
          { value: 'restart', label: 'Restart Setup' },
        ],
        placeholder: 'Type your reply here',
      };
    }

    return {
      kind: 'none',
      hint: 'Setup Assistant is getting things ready.',
      placeholder: 'Setup Assistant is warming up...',
    };
  }, [ceremonyPackagePath, directoryChoice, nodeCatalog, phase, publicHost, selectedRole?.package_hint]);

  useEffect(() => {
    if (promptConfig.kind !== 'select') {
      setSelectValue('');
      return;
    }

    setSelectValue((current) => {
      if (promptConfig.options.some((option) => option.value === current)) {
        return current;
      }
      return promptConfig.options[0]?.value || '';
    });
  }, [promptConfig]);

  const selectedRoleHighlights = selectedRole ? [
    ...((selectedRole.responsibilities || []).slice(0, 3)),
    ...(setupMode === 'ceremony' && selectedRole.package_hint ? [selectedRole.package_hint] : []),
  ] : [];
  const selectedRoleServices = selectedRole ? (selectedRole.service_surface || []) : [];
  const hidePromptHint = promptConfig.kind === 'select' || promptConfig.kind === 'choices';
  const setupNote = phase === 'error'
    ? 'Something interrupted setup. Resolve the issue and restart the setup flow.'
    : setupMode === 'ceremony'
      ? 'I will import an approved genesis package, place it in a dedicated Control Panel workspace, and keep this machine aligned with the canonical beta manifests. Genesis Setup should be the only runtime owner for that validator on this machine.'
      : 'I will walk you through setup, place the node in its own private folder, and keep every step aligned with the selected node role.';
  const previewStatus = ceremonyImportResult ? 'Imported' : provisionResult?.node ? 'Created' : 'Pending';
  const previewNotes = ceremonyImportResult?.next_steps?.length
    ? ceremonyImportResult.next_steps.slice(0, 3)
    : ['Jarvis will append a unique suffix automatically if the requested workspace path is already in use.'];

  return (
    <section className={`jarvis-shell ${shellReady ? 'is-ready' : ''}`}>
      <div className="jarvis-layout">
        <article className="jarvis-chat-stage">
          <div className="jarvis-panel-header">
            <div>
              <h2 className="jarvis-panel-title">Setup Assistant</h2>
            </div>
            <div className={`jarvis-phase-chip jarvis-phase-chip-${setupStatus.tone} ${running ? 'is-active' : ''}`}>
              {setupStatus.label}
            </div>
          </div>

          <div className="jarvis-chat-window">
            <div className="jarvis-chat-log">
              {messages.map((message) => (
                <div key={message.id} className={`jarvis-chat-message jarvis-${message.sender}`}>
                  <span className="jarvis-chat-author">{message.sender === 'user' ? 'You' : 'Jarvis'}</span>
                  {message.type === 'code' ? <pre>{message.text}</pre> : <p>{message.text}</p>}
                </div>
              ))}

              {typing ? (
                <div className="jarvis-chat-message jarvis-jarvis jarvis-typing-message">
                  <div className="jarvis-typing-stack">
                    <span className="jarvis-chat-author">Jarvis</span>
                    <div className="jarvis-typing-indicator" aria-label="Jarvis is typing">
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                  </div>
                </div>
              ) : null}

              <div ref={messagesEndRef} />
            </div>

            <div className="jarvis-chat-controls">
              {!typing && promptConfig.kind === 'choices' ? (
                <div className="jarvis-choice-list">
                  {promptConfig.options.map((option) => (
                    <SNRGButton
                      key={option.value}
                      as="button"
                      variant="blue"
                      size="sm"
                      className="jarvis-choice-pill"
                      onClick={() => submitChoice(option.value, option.label)}
                      disabled={running}
                    >
                      {option.label}
                    </SNRGButton>
                  ))}
                </div>
              ) : null}

              {promptConfig.kind === 'select' ? (
                <form className="jarvis-select-row" onSubmit={submitSelect}>
                  <select value={selectValue} onChange={(event) => setSelectValue(event.target.value)} disabled={running}>
                    {promptConfig.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <SNRGButton as="button" type="submit" variant="blue" size="sm" disabled={running || !selectValue}>
                    Continue
                  </SNRGButton>
                </form>
              ) : null}

              {promptConfig.kind === 'package' ? (
                <div className="jarvis-choice-list">
                  <SNRGButton
                    as="button"
                    variant="blue"
                    size="sm"
                    className="jarvis-choice-pill"
                    onClick={() => {
                      void selectCeremonyPackage();
                    }}
                    disabled={running}
                  >
                    Select Package
                  </SNRGButton>
                  <SNRGButton
                    as="button"
                    variant="blue"
                    size="sm"
                    className="jarvis-choice-pill"
                    onClick={() => {
                      void runCeremonyImport();
                    }}
                    disabled={running || !ceremonyPackagePath}
                  >
                    Import Package
                  </SNRGButton>
                  <SNRGButton
                    as="button"
                    variant="blue"
                    size="sm"
                    className="jarvis-choice-pill"
                    onClick={() => {
                      void handoffToDashboard();
                    }}
                    disabled={running}
                  >
                    Return to Dashboard
                  </SNRGButton>
                </div>
              ) : null}

              {!hidePromptHint && promptConfig.hint ? (
                <p className="jarvis-chat-hint">{promptConfig.hint}</p>
              ) : null}

              {promptConfig.kind === 'package' && ceremonyPackagePath ? (
                <p className="jarvis-chat-hint">Selected package: {ceremonyPackagePath}</p>
              ) : null}

              <form className="jarvis-chat-form" onSubmit={submitChat}>
                <input
                  type="text"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder={promptConfig.placeholder || 'Type a message for Jarvis'}
                  disabled={chatInputLocked}
                />
                <SNRGButton as="button" type="submit" variant="blue" size="sm" disabled={chatInputLocked || !input.trim()}>
                  Send
                </SNRGButton>
              </form>
            </div>
          </div>
        </article>

        <aside className="jarvis-side-stage">
          <section className="jarvis-detail-card">
            <div className="jarvis-detail-header">
              <h3>Setup status</h3>
              <span>{setupStatus.label}</span>
            </div>
            <p className="jarvis-detail-copy">{setupNote}</p>
            <div className="jarvis-status-list">
              {statusItems.map((item) => (
                <div key={item.label} className="jarvis-status-row">
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>
          </section>

          <section className="jarvis-detail-card">
            <div className="jarvis-detail-header">
              <h3>Selected node type</h3>
              <span>{selectedRole?.class_name || 'Choose a role'}</span>
            </div>
            <p className="jarvis-detail-copy">{selectedRole?.summary || 'Choose a node type and its job details will appear here.'}</p>
            <div className="jarvis-plan-list">
              {selectedRoleHighlights.length ? selectedRoleHighlights.map((line) => <p key={line}>{line}</p>) : <p>Role responsibilities will appear here.</p>}
            </div>
            {selectedRoleServices.length ? (
              <div className="jarvis-choice-list jarvis-choice-list-static">
                {selectedRoleServices.slice(0, 6).map((entry) => (
                  <span key={entry} className="jarvis-choice-pill jarvis-choice-pill-static">{entry}</span>
                ))}
              </div>
            ) : null}
          </section>

          <section className="jarvis-detail-card">
            <div className="jarvis-detail-header">
              <h3>Network resources</h3>
              <span>Safe to continue</span>
            </div>
            <div className="jarvis-status-list">
              <div className="jarvis-status-row">
                <span>Treasury wallet</span>
                <strong>{truncateAddress(networkProfile?.treasury_wallet?.address)}</strong>
              </div>
              <div className="jarvis-status-row">
                <span>Faucet wallet</span>
                <strong>{truncateAddress(networkProfile?.faucet_wallet?.address)}</strong>
              </div>
              <div className="jarvis-status-row">
                <span>Stake vault</span>
                <strong>{truncateAddress(networkProfile?.stake_vault_wallet?.address)}</strong>
              </div>
              <div className="jarvis-status-row">
                <span>Minimum stake</span>
                <strong>{formatStake(networkProfile?.funding_manifests?.[0]?.amount_snrg || '5000')}</strong>
              </div>
            </div>
            <div className="jarvis-plan-list">
              <p>Network entry points: {networkBootnodes.map((entry) => entry.host).join(', ') || 'Pending'}</p>
              <p>Support servers: {networkSeeds.map((entry) => entry.host).join(', ') || 'Pending'}</p>
            </div>
          </section>

          <section className="jarvis-detail-card">
            <div className="jarvis-detail-header">
              <h3>Provision preview</h3>
              <span>{previewStatus}</span>
            </div>
            <div className="jarvis-status-list">
              <div className="jarvis-status-row">
                <span>Isolated path</span>
                <strong>{directoryChoice || 'Will be generated after role selection'}</strong>
              </div>
              {setupMode === 'ceremony' ? (
                <div className="jarvis-status-row">
                  <span>Approved package</span>
                  <strong>{ceremonyPackagePath || 'Choose a package from the Genesis Dashboard'}</strong>
                </div>
              ) : null}
              {ceremonyImportResult?.workspace_directory ? (
                <div className="jarvis-status-row">
                  <span>Imported workspace</span>
                  <strong>{ceremonyImportResult.workspace_directory}</strong>
                </div>
              ) : null}
            </div>
            <div className="jarvis-plan-list">
              {previewNotes.map((line) => <p key={line}>{line}</p>)}
            </div>
          </section>
        </aside>
      </div>

      <div className="jarvis-terminal-stage wizard-terminal-panel">
        <div className="wizard-terminal-header">
          <span>Setup terminal</span>
          <code>{terminalCwd || '~'}</code>
        </div>
        <div className="wizard-terminal-body" ref={terminalScrollRef}>
          {terminalLines.map((line) => (
            <div key={line.id} className={`wizard-terminal-line ${line.kind}`}>
              <span className="wizard-terminal-time">{line.at}</span>
              <span className="wizard-terminal-text">{line.text}</span>
            </div>
          ))}
        </div>
        <form className="wizard-terminal-input-row" onSubmit={submitTerminal}>
          <span className="wizard-terminal-prompt">$</span>
          <input
            value={terminalInput}
            onChange={(event) => setTerminalInput(event.target.value)}
            placeholder="Run local command (example: whoami)"
            disabled={terminalBusy}
          />
          <SNRGButton as="button" variant="blue" size="sm" type="submit" disabled={terminalBusy || !terminalInput.trim()}>
            Run
          </SNRGButton>
        </form>
      </div>
    </section>
  );
}

const TESTNET_FALLBACK_DISPLAY = 'Testnet-Beta';

export default TestnetBetaJarvisSetup;
