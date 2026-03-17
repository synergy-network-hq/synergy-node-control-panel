import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invoke } from '../lib/desktopClient';
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

const promptKindsWithSelections = new Set([
  'await_node_type',
  'review_device',
  'review_directory',
  'ready_provision',
  'error',
]);

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

  const [terminalCwd, setTerminalCwd] = useState('');
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalLines, setTerminalLines] = useState([]);

  const selectedRole = useMemo(
    () => nodeCatalog.find((entry) => entry.id === selectedRoleId) || null,
    [nodeCatalog, selectedRoleId],
  );
  const setupStatus = useMemo(
    () => deriveSetupStatus(phase, running, Boolean(provisionResult?.node)),
    [phase, provisionResult?.node, running],
  );
  const chatInputLocked = useMemo(
    () => running || phase === 'booting' || promptKindsWithSelections.has(phase),
    [phase, running],
  );

  const statusItems = useMemo(() => ([
    { label: 'Environment', value: networkProfile?.display_name || TESTNET_FALLBACK_DISPLAY },
    { label: 'Detected host', value: deviceProfile?.hostname || 'Detecting...' },
    { label: 'Provisioned nodes', value: existingNodes.length ? String(existingNodes.length) : '0' },
    { label: 'Selected node type', value: selectedRole?.display_name || 'Awaiting selection' },
  ]), [deviceProfile?.hostname, existingNodes.length, networkProfile?.display_name, selectedRole?.display_name]);

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
    setNodeCatalog(Array.isArray(data?.node_catalog) ? data.node_catalog : []);
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
        },
      });

      setProvisionResult(result);
      setTerminalCwd(result?.node?.workspace_directory || terminalCwd);
      addTerminalLine('success', `Workspace created: ${result?.node?.workspace_directory || 'unknown path'}`);
      (result?.node?.config_paths || []).forEach((path) => addTerminalLine('output', `Generated: ${path}`));
      addTerminalLine('output', `Reward wallet: ${result?.node?.node_address || 'unknown address'}`);
      addTerminalLine('info', `Funding manifest: ${result?.node?.funding_manifest_id || 'pending'}`);
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
    queueJarvisMessage,
    queueJarvisMessages,
    refreshState,
    selectedRole,
    terminalCwd,
  ]);

  const handleResponseValue = useCallback(async (value) => {
    if (!value || running) return;

    if (/^(dashboard|not now jarvis|not now|later)$/i.test(String(value).trim())) {
      await handoffToDashboard();
      return;
    }

    if (/^(restart|start over|reset)$/i.test(String(value).trim())) {
      resetMessageQueue();
      setSelectedRoleId('');
      setPublicHost('');
      setDirectoryChoice('');
      setProvisionResult(null);
      setPhase('await_node_type');
      await queueJarvisMessage('I cleared the previous setup steps. Choose the kind of node you want to set up.');
      return;
    }

    if (phase === 'await_node_type') {
      const nextRole = nodeCatalog.find((entry) => entry.id === value);
      if (!nextRole) {
        await queueJarvisMessage('Choose one of the node types in the list and I will load the right setup for it.');
        return;
      }

      const nextDirectory = suggestedDirectory(deviceProfile?.home_directory || '~', nextRole.id);
      setSelectedRoleId(nextRole.id);
      setDirectoryChoice(nextDirectory);
      setPhase('review_device');

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
      return;
    }

    if (phase === 'review_device') {
      if (/^refresh/i.test(String(value).trim())) {
        setRunning(true);
        try {
          await refreshState(true);
        } finally {
          setRunning(false);
        }
        return;
      }

      if (isContinueValue(value)) {
        setRunning(true);
        try {
          const detected = await refreshPublicHost({ announce: true });
          if (detected) {
            await queueJarvisMessage(`Public endpoint detected as ${detected}.`);
          } else {
            await queueJarvisMessage('I could not auto-detect a public endpoint right now, but setup can continue.');
          }
        } finally {
          setRunning(false);
        }
        setPhase('review_directory');
        await queueJarvisMessage(`The private folder I plan to use is ${directoryChoice}. Type "use default" to keep it, or paste a different folder path.`);
        return;
      }

      await queueJarvisMessage('Choose Continue if these details look right, or Refresh Detection if you want me to check again.');
      return;
    }

    if (phase === 'review_directory') {
      const trimmed = String(value || '').trim();
      if (!isContinueValue(value) && trimmed) {
        if (/^auto[\s-]*detect$/i.test(trimmed)) {
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
        }
        setDirectoryChoice(String(value).trim());
      }
      setPhase('ready_provision');
      await queueJarvisMessage('Everything is ready. I will create the private folder, generate the node wallet, write the setup files, and prepare the required 5,000 SNRG stake for this node.');
      return;
    }

    if (phase === 'ready_provision') {
      if (isContinueValue(value)) {
        await runProvision();
        return;
      }

      await queueJarvisMessage('Choose Provision Node when you are ready.');
      return;
    }

    if (phase === 'error') {
      await queueJarvisMessage('Type restart to try setup again, or say "not now jarvis" and I will take you to the dashboard.');
    }
  }, [
    deviceProfile?.home_directory,
    directoryChoice,
    handoffToDashboard,
    nodeCatalog,
    phase,
    queueJarvisMessage,
    queueJarvisMessages,
    refreshState,
    resetMessageQueue,
    runProvision,
    running,
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
  }, [directoryChoice, nodeCatalog, phase]);

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
  ] : [];
  const selectedRoleServices = selectedRole ? (selectedRole.service_surface || []) : [];
  const hidePromptHint = promptConfig.kind === 'select' || promptConfig.kind === 'choices';
  const setupNote = phase === 'error'
    ? 'Something interrupted setup. Resolve the issue and restart the setup flow.'
    : 'I will walk you through setup, place the node in its own private folder, and keep every step aligned with the selected node role.';

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
              {promptConfig.kind === 'choices' ? (
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

              {!hidePromptHint && promptConfig.hint ? (
                <p className="jarvis-chat-hint">{promptConfig.hint}</p>
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
              <span>{selectedRole?.class_name || 'Choose a node type'}</span>
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
              <span>{provisionResult?.node ? 'Created' : 'Pending'}</span>
            </div>
            <div className="jarvis-status-list">
              <div className="jarvis-status-row">
                <span>Isolated path</span>
                <strong>{directoryChoice || 'Will be generated after role selection'}</strong>
              </div>
            </div>
            <div className="jarvis-plan-list">
              <p>Jarvis will append a unique suffix automatically if the requested workspace path is already in use.</p>
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
