import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invoke } from '../lib/desktopClient';
import {
  applyStoredTestnetPortSettings,
  formatPortSettingsSummary,
  refreshTestnetBootstrapConfig,
} from '../lib/testnetBootstrap';
import { clearTestnetDashboardCache } from './TestnetDashboard';
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

function isPublicIpv4Address(host) {
  const segments = String(host || '').split('.');
  if (segments.length !== 4) return false;
  const values = segments.map((segment) => {
    if (!/^\d+$/.test(segment)) return null;
    const value = Number.parseInt(segment, 10);
    return value >= 0 && value <= 255 ? value : null;
  });
  if (values.some((value) => value === null)) return false;

  const [first, second, third] = values;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 0 && third === 0) return false;
  if (first === 192 && second === 0 && third === 2) return false;
  if (first === 192 && second === 168) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function normalizePublicHostInput(value) {
  let candidate = String(value || '').trim();
  if (!candidate) return '';

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    try {
      candidate = new URL(candidate).hostname;
    } catch {
      return '';
    }
  }

  candidate = candidate
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.+$/, '')
    .trim()
    .toLowerCase();

  if (candidate.includes('/') || candidate.includes('@') || candidate.includes(' ')) {
    return '';
  }

  if (candidate.includes(':') && !/^[0-9a-f:]+$/i.test(candidate)) {
    const [hostPart, portPart] = candidate.split(':');
    if (!/^\d+$/.test(portPart || '')) return '';
    candidate = hostPart;
  }

  if (isPublicIpv4Address(candidate)) return candidate;
  if (/^[0-9a-f:]+$/i.test(candidate) && candidate.includes(':')) {
    const lowered = candidate.toLowerCase();
    if (
      lowered === '::1'
      || lowered === '::'
      || lowered.startsWith('fe80:')
      || lowered.startsWith('fc')
      || lowered.startsWith('fd')
    ) {
      return '';
    }
    return candidate;
  }

  if (
    candidate === 'localhost'
    || candidate.endsWith('.local')
    || !candidate.includes('.')
    || !/^[a-z0-9.-]+$/.test(candidate)
    || candidate.startsWith('.')
    || candidate.endsWith('.')
  ) {
    return '';
  }

  return candidate;
}

function suggestedDirectory(homeDirectory, roleId) {
  const base = String(homeDirectory || '~').replace(/[\\/]+$/, '');
  return `${base}/.synergy/testnet/nodes/${sanitizeSlug(roleId || 'node')}-workspace`;
}

function formatStake(value) {
  const text = String(value ?? '').trim();
  if (!text) return '50,000 SNRG';
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

const REMOTE_DEPLOYMENT_ROLES = new Set(['validator', 'rpc_gateway', 'indexer']);
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

function TestnetJarvisSetup({ onComplete, onDefer }) {
  const initializedRef = useRef(false);
  const messagesEndRef = useRef(null);
  const terminalScrollRef = useRef(null);
  const messageQueueRef = useRef(Promise.resolve());
  const conversationEpochRef = useRef(0);
  const navigate = useNavigate();

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState('booting');
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
  const [identityPassphrase, setIdentityPassphrase] = useState('');
  const [provisionResult, setProvisionResult] = useState(null);

  const [terminalCwd, setTerminalCwd] = useState('');
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalLines, setTerminalLines] = useState([]);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [showDeveloperPanel, setShowDeveloperPanel] = useState(false);

  const selectedRole = useMemo(
    () => nodeCatalog.find((entry) => entry.id === selectedRoleId) || null,
    [nodeCatalog, selectedRoleId],
  );
  const setupStatus = useMemo(
    () => deriveSetupStatus(phase, running, Boolean(provisionResult?.node)),
    [phase, provisionResult?.node, running],
  );
  const selectedRoleDisplayName = selectedRole?.display_name || 'Awaiting selection';
  const chatInputLocked = running || phase === 'booting';

  const statusItems = useMemo(() => ([
    { label: 'Environment', value: networkProfile?.display_name || 'Synergy Testnet' },
    { label: 'Detected host', value: deviceProfile?.hostname || 'Detecting...' },
    { label: 'Setup mode', value: 'Standard onboarding' },
    { label: 'Provisioned nodes', value: existingNodes.length ? String(existingNodes.length) : '0' },
    { label: 'Selected node type', value: selectedRoleDisplayName },
  ]), [deviceProfile?.hostname, existingNodes.length, networkProfile?.display_name, selectedRoleDisplayName]);

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
      'https://api.ipify.org?format=text',
      'https://api4.ipify.org?format=text',
      'https://ifconfig.me/ip',
    ];

    for (const endpoint of candidates) {
      try {
        const response = await fetch(endpoint, { cache: 'no-store' });
        if (!response.ok) continue;
        const value = normalizePublicHostInput(await response.text());
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
    clearTestnetDashboardCache();
    navigate('/');
  }, [navigate, onComplete, onDefer, queueJarvisMessages, resetMessageQueue]);

  const refreshState = useCallback(async (announce = false) => {
    const data = await invoke('testnet_get_state');
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
    addTerminalLine('info', 'Loading the Testnet node catalog and local device profile...');
    try {
      await queueJarvisMessages([
        {
          text: 'Hello, and welcome.',
          typingMs: 1000,
          pauseMs: 800,
        },
        {
          text: 'I am Jarvis, your setup assistant.',
          typingMs: 1200,
          pauseMs: 800,
        },
      ]);

      await refreshState(false);
      await refreshPublicHost({ announce: true });

      await queueJarvisMessages([
        {
          text: 'I will help you set up a Synergy Testnet node using the standard onboarding flow.',
          typingMs: 1300,
          pauseMs: 800,
        },
        {
          text: 'Choose the node role, confirm this machine, and I will create the private workspace, runtime config, wallet, bootstrap manifest, and funding manifest.',
          typingMs: 1500,
          pauseMs: 900,
        },
        {
          text: 'What type of node would you like to set up?',
          typingMs: 900,
          pauseMs: 600,
        },
      ]);

      setPhase('await_node_type');
    } catch (error) {
      addTerminalLine('error', `Failed to initialize Testnet setup: ${String(error)}`);
      await queueJarvisMessages([
        {
          text: 'Something interrupted setup on my end.',
          typingMs: 1000,
          pauseMs: 800,
        },
        {
          text: 'Please close and reopen the control panel to try again.',
          typingMs: 1100,
        },
      ]);
      setPhase('error');
    } finally {
      setRunning(false);
    }
  }, [addTerminalLine, queueJarvisMessages, refreshPublicHost, refreshState]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    bootstrap();
  }, [bootstrap]);

  const runProvision = useCallback(async () => {
    if (!selectedRole) {
      await queueJarvisMessage('Select a node role before provisioning.');
      return;
    }

    setRunning(true);
    addTerminalLine('info', `Provisioning ${selectedRole.display_name} in an isolated Testnet workspace...`);
    addTerminalLine('info', 'Provisioning started with role-validated runtime and bootstrap configuration.');

    try {
      const result = await invoke('testnet_setup_node', {
        input: {
          roleId: selectedRole.id,
          displayLabel: selectedRole.display_name,
          intendedDirectory: directoryChoice || null,
          publicHost: publicHost || null,
          identityPassphrase: selectedRole.id === 'validator' ? identityPassphrase || null : null,
        },
      });

      setProvisionResult(result);
      setTerminalCwd(result?.node?.workspace_directory || terminalCwd);
      addTerminalLine('success', `Workspace created: ${result?.node?.workspace_directory || 'unknown path'}`);
      (result?.node?.config_paths || []).forEach((path) => addTerminalLine('output', `Generated: ${path}`));
      addTerminalLine('output', `Reward wallet: ${result?.node?.node_address || 'unknown address'}`);
      addTerminalLine('info', `Funding manifest: ${result?.node?.funding_manifest_id || 'pending'}`);
      try {
        const portConfig = await applyStoredTestnetPortSettings(result?.node);
        addTerminalLine(
          'info',
          `Electron wrote node.toml port profile: ${formatPortSettingsSummary(portConfig.portSettings)}.`,
        );
      } catch (portError) {
        addTerminalLine('info', `Electron port profile update skipped: ${String(portError)}`);
      }
      try {
        const bootstrapConfig = await refreshTestnetBootstrapConfig(
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
      addTerminalLine('info', 'Provisioning finished. The workspace is configured and will enter the mandatory sync gate now.');

      await queueJarvisMessages([
        {
          text: `${selectedRole.display_name} is ready.`,
          typingMs: 620,
          pauseMs: 220,
        },
        {
          text: selectedRole.id === 'validator'
            ? 'I created this validator workspace directly on this machine, including the node wallet, runtime config, bootstrap manifest, and funding manifest. Fund, bond, and activate it from the validator detail page after sync.'
            : 'I created the private workspace and prepared the node wallet. Next I will start the runtime and watch chain sync before dashboard operations are enabled.',
          typingMs: 980,
        },
      ]);

      await refreshState(false);
      if (typeof onComplete === 'function') {
        onComplete({ syncNodeId: result?.node?.id || '' });
      }
      clearTestnetDashboardCache();
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
    addTerminalLine,
    directoryChoice,
    identityPassphrase,
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

    if (/^developer data please$/i.test(trimmedValue)) {
      setShowDeveloperPanel((prev) => !prev);
      await queueJarvisMessage(
        showDeveloperPanel
          ? 'Developer panel hidden.'
          : 'Developer panel unlocked. Setup diagnostics are now visible on the right.',
      );
      return;
    }

    if (/^(i need a terminal|open terminal|show terminal)$/i.test(trimmedValue)) {
      setTerminalVisible(true);
      await queueJarvisMessage('Opening the local setup terminal at the bottom of the screen. You can inspect the workspace or run commands there any time.');
      return;
    }

    if (/^(hide terminal|close terminal)$/i.test(trimmedValue)) {
      setTerminalVisible(false);
      await queueJarvisMessage('Terminal hidden.');
      return;
    }

    if (/^(dashboard|not now jarvis|not now|later)$/i.test(trimmedValue)) {
      await handoffToDashboard();
      return;
    }

    if (/^(restart|start over|reset)$/i.test(trimmedValue)) {
      resetMessageQueue();
      setSelectedRoleId('');
      setPublicHost('');
      setDirectoryChoice('');
      setIdentityPassphrase('');
      setProvisionResult(null);
      setPhase('await_node_type');
      await queueJarvisMessage('I cleared the previous setup steps. Choose the kind of node you want to set up.');
      return;
    }

    if (phase === 'await_node_type') {
      const normalized = trimmedValue.toLowerCase();
      const nextRole = nodeCatalog.find((entry) => {
        const id = String(entry?.id || '').toLowerCase();
        const display = String(entry?.display_name || '').toLowerCase();
        const klass = String(entry?.class_name || '').toLowerCase();
        return id === normalized
          || display === normalized
          || klass === normalized
          || display.includes(normalized)
          || id.startsWith(normalized);
      });

      if (!nextRole) {
        const options = nodeCatalog
          .map((entry) => entry.display_name)
          .filter(Boolean)
          .slice(0, 6)
          .join(', ');
        await queueJarvisMessages([
          {
            text: "I didn't recognize that node type.",
            typingMs: 900,
            pauseMs: 700,
          },
          {
            text: options
              ? `You can pick any of these: ${options}.`
              : 'Please try again with a valid node type name.',
            typingMs: 1200,
          },
        ]);
        return;
      }

      const nextDirectory = suggestedDirectory(deviceProfile?.home_directory || '~', nextRole.id);
      setSelectedRoleId(nextRole.id);
      setDirectoryChoice(nextDirectory);
      setIdentityPassphrase('');
      setProvisionResult(null);

      await queueJarvisMessages([
        {
          text: `Selected: ${nextRole.display_name}.`,
          typingMs: 800,
          pauseMs: 700,
        },
        {
          text: `I'll set up a private workspace at ${nextDirectory}.`,
          typingMs: 1100,
          pauseMs: 700,
        },
        {
          text: 'Take a quick look at the computer details. If they look right, continue. If not, refresh and I will check again.',
          typingMs: 1100,
          pauseMs: 220,
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

        if (REMOTE_DEPLOYMENT_ROLES.has(selectedRoleId)) {
          const detectedNote = detected
            ? `I detected this machine's IP as ${detected}.`
            : "I couldn't auto-detect an IP for this machine.";
          const hostPrompt = selectedRoleId === 'validator'
            ? 'This validator must advertise a public P2P endpoint so seeds and peers can reach it. '
            : 'This role is built to run on a dedicated public server. ';
          await queueJarvisMessage(
            `${detectedNote} ${hostPrompt}` +
            'Enter the public IP address or DNS name for this machine, or choose "Use Detected" to keep the value above.',
          );
          setPhase('confirm_public_host');
        } else {
          await queueJarvisMessage(
            `The private folder I plan to use is ${directoryChoice}. Type "use default" to keep it, or paste a different folder path.`,
          );
          setPhase('review_directory');
        }
        return;
      }

      await queueJarvisMessage('Choose Continue if these details look right, or Refresh Detection if you want me to check again.');
      return;
    }

    if (phase === 'confirm_public_host') {
      let nextPublicHost = '';

      if (!/^use[\s-]*detected$/i.test(trimmedValue) && trimmedValue) {
        nextPublicHost = normalizePublicHostInput(trimmedValue);
        if (!nextPublicHost) {
          await queueJarvisMessage('Enter a publicly routable IP address or DNS name for this node. Private, localhost, and malformed addresses cannot join the public Testnet path.');
          return;
        }
        setPublicHost(nextPublicHost);
        await queueJarvisMessage(`Public endpoint set to ${nextPublicHost}. This will be written into the runtime config for this node.`);
      } else {
        nextPublicHost = normalizePublicHostInput(publicHost);
        if (selectedRoleId === 'validator' && !nextPublicHost) {
          await queueJarvisMessage('I do not have a usable public endpoint yet. Enter the validator public IP address or DNS name before provisioning.');
          return;
        }
        if (nextPublicHost) {
          setPublicHost(nextPublicHost);
        }
        await queueJarvisMessage(
          nextPublicHost
            ? `Using public endpoint: ${nextPublicHost}.`
            : 'No public endpoint was set for this non-validator role.',
        );
      }
      await queueJarvisMessage(
        `The private folder I plan to use is ${directoryChoice}. Type "use default" to keep it, or paste a different folder path.`,
      );
      setPhase('review_directory');
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
                : 'Public endpoint is still not responding. Continuing without it.',
            );
          } finally {
            setRunning(false);
          }
        } else {
          setDirectoryChoice(trimmedValue);
        }
      }
      await queueJarvisMessage(
        selectedRoleId === 'validator'
          ? 'The workspace path is set. Next, enter the validator identity encryption passphrase. Jarvis will use the address engine to generate the validator address and local signing key, then write the encrypted key export.'
          : 'Everything is ready. I will create the private folder, generate the node wallet, write the setup files, and prepare the funding manifest for this node.',
      );
      setPhase(selectedRoleId === 'validator' ? 'set_identity_passphrase' : 'ready_provision');
      return;
    }

    if (phase === 'set_identity_passphrase') {
      if (trimmedValue.length < 8) {
        await queueJarvisMessage('Enter an identity encryption passphrase with at least 8 characters before provisioning this validator.');
        return;
      }
      setIdentityPassphrase(trimmedValue);
      await queueJarvisMessage(
        'Everything is ready. I will create the validator workspace, write the runtime files, and prepare the funding manifest for the required 50,000 SNRG stake. You will still fund, bond, and activate from the validator detail page after sync.',
      );
      setPhase('ready_provision');
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
      await queueJarvisMessage('Something interrupted setup. Please close and reopen the control panel to try again.');
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
    runProvision,
    running,
    selectedRoleId,
    showDeveloperPanel,
  ]);

  const submitChat = useCallback(async (event) => {
    event.preventDefault();
    const value = input.trim();
    if (!value || running || phase === 'booting') return;

    addMessage('user', phase === 'set_identity_passphrase' ? '********' : value);
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

    const label = nodeCatalog.find((entry) => entry.id === selectValue)?.display_name || selectValue;
    addMessage('user', label);
    await handleResponseValue(selectValue);
  }, [addMessage, handleResponseValue, nodeCatalog, running, selectValue]);

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

    if (phase === 'confirm_public_host') {
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
        placeholder: 'Enter server IP or DNS name, or use detected',
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

    if (phase === 'set_identity_passphrase') {
      return {
        kind: 'text',
        inputType: 'password',
        hint: 'This passphrase protects the encrypted validator key export. The runtime keeps the local signing key inside this private workspace.',
        placeholder: 'Enter validator identity passphrase',
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
  }, [directoryChoice, nodeCatalog, phase, publicHost]);

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

  const selectedRoleHighlights = selectedRole ? (selectedRole.responsibilities || []).slice(0, 3) : [];
  const selectedRoleServices = selectedRole ? (selectedRole.service_surface || []) : [];
  const hidePromptHint = promptConfig.kind === 'select' || promptConfig.kind === 'choices';
  const setupNote = phase === 'error'
    ? 'Something interrupted setup. Resolve the issue and restart the setup flow.'
    : 'I will walk you through standard Testnet setup, place the node in its own private folder, and keep every step aligned with the selected role.';
  const previewStatus = provisionResult?.node ? 'Created' : phase === 'ready_provision' ? 'Ready' : 'Pending';
  const previewNotes = ['Jarvis will append a unique suffix automatically if the requested workspace path is already in use.'];

  return (
    <section
      className={`jarvis-shell ${shellReady ? 'is-ready' : ''}`}
      data-developer={showDeveloperPanel ? 'true' : 'false'}
    >
      <div className="jarvis-layout">
        <article className="jarvis-chat-stage">
          <div className="jarvis-panel-header">
            <div>
              <h2 className="jarvis-panel-title">Welcome!</h2>
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
              {promptConfig.hint && !hidePromptHint ? (
                <div className="jarvis-choice-hint">
                  <p>{promptConfig.hint}</p>
                </div>
              ) : null}

              {promptConfig.kind === 'select' ? (
                <form className="jarvis-choice-select" onSubmit={submitSelect}>
                  <div className="jarvis-choice-header">
                    <strong>Choose an option</strong>
                    {promptConfig.hint ? <span>{promptConfig.hint}</span> : null}
                  </div>
                  <div className="jarvis-choice-select-row">
                    <select value={selectValue} onChange={(event) => setSelectValue(event.target.value)} disabled={running}>
                      {promptConfig.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <SNRGButton as="button" type="submit" variant="purple" size="sm" disabled={running || !selectValue}>
                      Choose
                    </SNRGButton>
                  </div>
                </form>
              ) : null}

              {promptConfig.kind === 'choices' ? (
                <div className="jarvis-choice-list jarvis-choice-list-utility">
                  {promptConfig.hint ? (
                    <div className="jarvis-choice-header">
                      <strong>Quick choices</strong>
                      <span>{promptConfig.hint}</span>
                    </div>
                  ) : null}
                  <div className="jarvis-choice-list-utility-row">
                    {promptConfig.options.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className="jarvis-choice-pill"
                        disabled={running}
                        onClick={() => void submitChoice(option.value, option.label)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <form className="jarvis-chat-form" onSubmit={submitChat}>
                <input
                  type={promptConfig.inputType || 'text'}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder={promptConfig.placeholder || 'Type your reply here'}
                  disabled={chatInputLocked}
                />
                <SNRGButton as="button" type="submit" variant="blue" size="sm" disabled={chatInputLocked || !input.trim()}>
                  Send
                </SNRGButton>
              </form>
            </div>
          </div>
        </article>

        {showDeveloperPanel ? (
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
                <strong>{formatStake(networkProfile?.funding_manifests?.[0]?.amount_snrg || '50000')}</strong>
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
              {provisionResult?.node?.workspace_directory ? (
                <div className="jarvis-status-row">
                  <span>Created workspace</span>
                  <strong>{provisionResult.node.workspace_directory}</strong>
                </div>
              ) : null}
            </div>
            <div className="jarvis-plan-list">
              {previewNotes.map((line) => <p key={line}>{line}</p>)}
            </div>
          </section>
        </aside>
        ) : null}
      </div>

      {terminalVisible ? (
        <div className="jarvis-terminal-stage wizard-terminal-panel">
          <div className="wizard-terminal-header">
            <span>Setup terminal</span>
            <code>{terminalCwd || '~'}</code>
            <SNRGButton
              as="button"
              variant="purple"
              size="sm"
              onClick={() => {
                setTerminalVisible(false);
              }}
            >
              Hide
            </SNRGButton>
          </div>
          <div className="wizard-terminal-scroll" ref={terminalScrollRef}>
            {terminalLines.map((line) => (
              <div key={line.id} className={`wizard-terminal-line terminal-${line.kind}`}>
                <span className="wizard-terminal-time">{line.at}</span>
                <span>{line.text}</span>
              </div>
            ))}
          </div>
          <form className="wizard-terminal-form" onSubmit={submitTerminal}>
            <input
              value={terminalInput}
              onChange={(event) => setTerminalInput(event.target.value)}
              placeholder="Run a setup command"
              disabled={terminalBusy}
            />
            <SNRGButton as="button" type="submit" variant="blue" size="sm" disabled={terminalBusy || !terminalInput.trim()}>
              Run
            </SNRGButton>
          </form>
        </div>
      ) : null}
    </section>
  );
}

export default TestnetJarvisSetup;
