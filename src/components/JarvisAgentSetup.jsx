import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invoke } from '../lib/desktopClient';

const PROVISION_SEQUENCE = ['setup', 'start', 'status'];
const DEVNET_NODE_LAYOUT = [
  ['node-01', 'node-14'],
  ['node-02', 'node-03'],
  ['node-04', 'node-05'],
  ['node-06', 'node-07'],
  ['node-08', 'node-09'],
  ['node-10', 'node-11'],
  ['node-12', 'node-13'],
  ['node-22', 'node-15'],
  ['node-16', 'node-17'],
  ['node-24', 'node-25'],
  ['node-18'],
  ['node-20'],
  ['node-23'],
];

const PHASE_LABELS = {
  booting: 'Initializing workspace',
  await_machine01_host: 'Discovering device-01',
  await_device_count: 'Confirming machine count',
  await_device_hosts: 'Mapping remaining machines',
  review: 'Reviewing assignment plan',
  ready_actions: 'Ready to provision',
  error: 'Needs attention',
};

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

function nodeSlotOrdinal(nodeSlotId) {
  const match = String(nodeSlotId || '').match(/(\d+)/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function sortNodeSlotIds(nodeSlotIds) {
  return [...nodeSlotIds].sort((a, b) => {
    const aNum = nodeSlotOrdinal(a);
    const bNum = nodeSlotOrdinal(b);
    if (aNum !== bNum) return aNum - bNum;
    return String(a).localeCompare(String(b));
  });
}

function computeAssignments(inventory, deviceCount, deviceHosts) {
  if (!Number.isFinite(deviceCount) || deviceCount < 1) {
    return [];
  }

  const inventorySet = new Set(inventory.map((entry) => entry.node_slot_id));
  if (
    deviceCount === 13
    && DEVNET_NODE_LAYOUT.every((group) => group.every((nodeSlotId) => inventorySet.has(nodeSlotId)))
  ) {
    return DEVNET_NODE_LAYOUT.map((nodeSlotIds, index) => ({
      deviceIndex: index,
      deviceLabel: `device-${String(index + 1).padStart(2, '0')}`,
      host: String(deviceHosts[index] || '').trim(),
      nodeSlotIds: [...nodeSlotIds],
    }));
  }

  const nodeSlotIds = sortNodeSlotIds(inventory.map((entry) => entry.node_slot_id));
  if (!nodeSlotIds.length) {
    return [];
  }

  const targetNodeCount = Math.min(nodeSlotIds.length, deviceCount * 2);
  const selectedIds = nodeSlotIds.slice(0, targetNodeCount);

  return Array.from({ length: deviceCount }, (_, index) => {
    const start = index * 2;
    return {
      deviceIndex: index,
      deviceLabel: `device-${String(index + 1).padStart(2, '0')}`,
      host: String(deviceHosts[index] || '').trim(),
      nodeSlotIds: selectedIds.slice(start, start + 2),
    };
  });
}

function truncateText(value, max = 420) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function normalizeOutputLines(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function isAffirmative(value) {
  return /^(y|yes|apply|apply plan|go|continue|start|ok)$/i.test(String(value || '').trim());
}

function isRestartCommand(value) {
  return /^(restart|restart wizard|reset|start over)$/i.test(String(value || '').trim());
}

function isDeferCommand(value) {
  return /^(not now jarvis|not now|later|skip for now|take me to the dashboard|dashboard)$/i.test(
    String(value || '').trim(),
  );
}

function isRefreshCommand(value) {
  return /^(refresh|refresh status|refresh fleet status|status)$/i.test(String(value || '').trim());
}

function isProvisionCommand(value) {
  return /^(provision|provision assigned nodes|provision and start|provision fleet|start assigned nodes)$/i.test(
    String(value || '').trim(),
  );
}

function formatSequence(sequence) {
  return sequence.join(' -> ');
}

function phaseDetailText(phase, currentDeviceIndex) {
  switch (phase) {
    case 'booting':
      return 'Connecting local control service, inventory, and workspace context.';
    case 'await_machine01_host':
      return 'Waiting for the reachable SSH host or IP that maps to node-01.';
    case 'await_device_count':
      return 'Waiting for the number of physical devices you want Jarvis to map.';
    case 'await_device_hosts':
      return `Waiting for the reachable SSH host or IP for device-${String(currentDeviceIndex + 1).padStart(2, '0')}.`;
    case 'review':
      return 'Review the generated assignment plan and apply it when ready.';
    case 'ready_actions':
      return 'Mappings are saved. Provision assigned nodes or hand off to the dashboard.';
    case 'error':
      return 'Setup hit an error. Type restart to begin again or inspect the terminal output below.';
    default:
      return '';
  }
}

function JarvisAgentSetup({ onComplete, onDefer }) {
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

  const [workspacePath, setWorkspacePath] = useState('');
  const [inventory, setInventory] = useState([]);
  const [configuredNodeSlotIds, setConfiguredMachineIds] = useState([]);

  const [machine01Host, setMachine01Host] = useState('');
  const [deviceCount, setDeviceCount] = useState(0);
  const [deviceHosts, setDeviceHosts] = useState([]);
  const [currentDeviceIndex, setCurrentDeviceIndex] = useState(0);

  const [defaults, setDefaults] = useState({
    sshUser: 'ops',
    sshPort: '22',
    sshKeyPath: '~/.ssh/id_ed25519',
    remoteRoot: '/opt/synergy',
    atlasBaseUrl: 'https://devnet-explorer.synergy-network.io',
  });

  const [haltedAction, setHaltedAction] = useState(null);
  const [snapshotSummary, setSnapshotSummary] = useState(null);
  const [terminalCwd, setTerminalCwd] = useState('');
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalLines, setTerminalLines] = useState([]);

  const assignmentPlan = useMemo(
    () => computeAssignments(inventory, deviceCount, deviceHosts),
    [inventory, deviceCount, deviceHosts],
  );

  const inventoryByNodeSlotId = useMemo(() => {
    const map = new Map();
    inventory.forEach((entry) => {
      map.set(entry.node_slot_id, entry);
    });
    return map;
  }, [inventory]);

  const maxDeviceCount = useMemo(() => {
    const suggestedCount = Math.ceil(Math.max(inventory.length, 1) / 2);
    return Math.max(1, Math.min(DEVNET_NODE_LAYOUT.length, suggestedCount || 1));
  }, [inventory.length]);

  const resetMessageQueue = useCallback(() => {
    conversationEpochRef.current += 1;
    messageQueueRef.current = Promise.resolve();
    setTyping(false);
  }, []);

  const addMessage = useCallback((sender, text, type = 'text') => {
    setMessages((prev) => [
      ...prev,
      {
        id: createId('message'),
        sender,
        text,
        type,
      },
    ]);
  }, []);

  const addTerminalLine = useCallback((kind, text) => {
    const lines = Array.isArray(text) ? text : [text];
    const nextLines = lines
      .map((line) => String(line || '').trimEnd())
      .filter((line) => line.length > 0)
      .map((line) => ({
        id: createId('terminal'),
        kind,
        text: line,
        at: formatClock(),
      }));

    if (!nextLines.length) {
      return;
    }

    setTerminalLines((prev) => [...prev, ...nextLines]);
  }, []);

  const queueJarvisMessage = useCallback(
    (text, type = 'text', options = {}) => {
      const messageText = String(text || '').trim();
      if (!messageText) {
        return Promise.resolve();
      }

      const epoch = conversationEpochRef.current;
      const typingMs = options.instant ? 0 : options.typingMs ?? Math.min(1550, 360 + messageText.length * 12);
      const pauseMs = options.pauseMs ?? 220;

      const job = async () => {
        if (epoch !== conversationEpochRef.current) {
          return;
        }

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
    },
    [addMessage],
  );

  const queueJarvisMessages = useCallback(
    async (items) => {
      for (const item of items) {
        await queueJarvisMessage(item.text, item.type || 'text', item);
      }
    },
    [queueJarvisMessage],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setShellReady(true);
    }, 90);

    return () => {
      window.clearTimeout(timer);
      resetMessageQueue();
    };
  }, [resetMessageQueue]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, typing]);

  useEffect(() => {
    terminalScrollRef.current?.scrollTo({
      top: terminalScrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [terminalLines]);

  const executeCommandAndLog = useCallback(
    async (command, cwdOverride = null) => {
      const effectiveCwd = cwdOverride || terminalCwd || workspacePath || null;
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
    },
    [addTerminalLine, terminalCwd, workspacePath],
  );

  const runTerminalCommand = useCallback(
    async (rawCommand) => {
      const command = String(rawCommand || '').trim();
      if (!command || terminalBusy) {
        return;
      }

      setTerminalBusy(true);
      try {
        const result = await executeCommandAndLog(command, terminalCwd || workspacePath || null);
        if (!result?.success && normalizeOutputLines(result?.stderr).length === 0) {
          addTerminalLine('error', `Command failed with exit code ${result?.exit_code ?? 'unknown'}`);
        }
      } catch (error) {
        addTerminalLine('error', String(error));
      } finally {
        setTerminalBusy(false);
      }
    },
    [addTerminalLine, executeCommandAndLog, terminalBusy, terminalCwd, workspacePath],
  );

  const submitTerminal = useCallback(
    async (event) => {
      event.preventDefault();
      const command = terminalInput.trim();
      if (!command) return;
      setTerminalInput('');
      await runTerminalCommand(command);
    },
    [runTerminalCommand, terminalInput],
  );

  const resetWizardState = useCallback(async () => {
    resetMessageQueue();
    setMachine01Host('');
    setDeviceCount(0);
    setDeviceHosts([]);
    setCurrentDeviceIndex(0);
    setConfiguredMachineIds([]);
    setHaltedAction(null);
    setSnapshotSummary(null);
    setPhase('await_machine01_host');
    addTerminalLine('info', 'Setup Assistant restarted. Awaiting node-01 SSH host/IP.');
    await queueJarvisMessages([
      {
        text: 'Understood. Restarting the setup conversation now.',
        typingMs: 580,
      },
      {
        text: 'Enter the reachable SSH host or IP for node-01 when you are ready.',
        typingMs: 760,
      },
    ]);
  }, [addTerminalLine, queueJarvisMessages, resetMessageQueue]);

  const handoffToDashboard = useCallback(async () => {
    resetMessageQueue();
    await queueJarvisMessages([
      {
        text: 'All right. We can park setup for now.',
        typingMs: 700,
      },
      {
        text: 'I will get you over to the dashboard so you can continue with the rest of the control panel.',
        typingMs: 940,
      },
    ]);

    if (typeof onDefer === 'function') {
      onDefer();
    } else if (typeof onComplete === 'function') {
      onComplete();
    }

    navigate('/');
  }, [navigate, onComplete, onDefer, queueJarvisMessages, resetMessageQueue]);

  const bootstrap = useCallback(async () => {
    setRunning(true);
    addTerminalLine('info', 'Connecting Setup Assistant to the local control service...');
    try {
      const workspace = await invoke('agent_monitor_initialize_workspace');
      const machines = await invoke('agent_get_inventory_machines');

      const orderedNodeSlots = sortNodeSlotIds(
        (Array.isArray(machines) ? machines : []).map((entry) => entry.node_slot_id),
      );

      setWorkspacePath(String(workspace || ''));
      setTerminalCwd(String(workspace || ''));
      setInventory(Array.isArray(machines) ? machines : []);

      addTerminalLine('success', `Workspace ready: ${String(workspace || 'unknown')}`);
      addTerminalLine('info', `Inventory loaded: ${orderedNodeSlots.length} node slots`);

      await queueJarvisMessages([
        {
          text: `I loaded the control-panel workspace and found ${orderedNodeSlots.length} node slots in the current inventory.`,
          typingMs: 860,
        },
        {
          text: 'The VPN is assumed to already be in place. I only need the reachable SSH addresses for the machines you want to map.',
          typingMs: 980,
        },
        {
          text: 'Start by entering the reachable SSH host or IP for node-01.',
          typingMs: 860,
        },
      ]);

      setPhase('await_machine01_host');
    } catch (error) {
      const reason = String(error);
      addTerminalLine('error', `Initialization failed: ${reason}`);
      await queueJarvisMessages([
        {
          text: 'I ran into a startup issue while connecting to the local control service.',
          typingMs: 760,
        },
        {
          text: 'Use the terminal output below to inspect the failure, then type restart to begin the setup again.',
          typingMs: 940,
        },
      ]);
      setPhase('error');
    } finally {
      setRunning(false);
    }
  }, [addTerminalLine, queueJarvisMessage, queueJarvisMessages]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    bootstrap();
  }, [bootstrap]);

  const logNodeControlResult = useCallback(
    (nodeSlotId, result) => {
      if (result?.command) {
        addTerminalLine('prompt', `[${nodeSlotId}] ${result.command}`);
      }
      normalizeOutputLines(result?.stdout).forEach((line) => addTerminalLine('output', `[${nodeSlotId}] ${line}`));
      normalizeOutputLines(result?.stderr).forEach((line) => addTerminalLine('error', `[${nodeSlotId}] ${line}`));
    },
    [addTerminalLine],
  );

  const runNodeAction = useCallback(
    async (nodeSlotId, action) => {
      try {
        const result = await invoke('monitor_node_control', { nodeSlotId, action });
        const success = Boolean(result?.success);

        logNodeControlResult(nodeSlotId, result);
        await queueJarvisMessage(
          `${nodeSlotId}: ${action} ${success ? 'completed successfully.' : 'failed and needs attention.'}`,
          'text',
          { typingMs: 280, pauseMs: 120 },
        );

        if (!success) {
          const stderrPreview = truncateText(result?.stderr || 'No stderr captured.');
          setHaltedAction({
            nodeSlotId,
            action,
            command: String(result?.command || ''),
            reason: stderrPreview,
          });
          await queueJarvisMessage(
            `I paused on ${nodeSlotId}:${action}. Review the terminal output, run the command manually if needed, then continue from the recovery card.`,
            'text',
            { typingMs: 680, pauseMs: 160 },
          );
        }

        return success;
      } catch (error) {
        const reason = String(error);
        setHaltedAction({
          nodeSlotId,
          action,
          command: '',
          reason,
        });
        addTerminalLine('error', `${nodeSlotId}:${action} failed to execute in-app: ${reason}`);
        await queueJarvisMessage(
          `${nodeSlotId}: ${action} could not execute in-app. Review the terminal output and continue manually if required.`,
        );
        return false;
      }
    },
    [addTerminalLine, logNodeControlResult, queueJarvisMessage],
  );

  const runSequenceForNodeSlot = useCallback(
    async (nodeSlotId, sequence, label) => {
      addTerminalLine('info', `${label} for ${nodeSlotId}: ${formatSequence(sequence)}`);
      await queueJarvisMessage(
        `Running ${label.toLowerCase()} on ${nodeSlotId}: ${formatSequence(sequence)}.`,
        'text',
        { typingMs: 360, pauseMs: 120 },
      );

      for (const action of sequence) {
        const ok = await runNodeAction(nodeSlotId, action);
        if (!ok) {
          return false;
        }
      }

      return true;
    },
    [addTerminalLine, queueJarvisMessage, runNodeAction],
  );

  const applyPlan = useCallback(async () => {
    if (!assignmentPlan.length) {
      await queueJarvisMessage('No assignment plan is available yet. Finish the host-mapping prompts first.');
      return;
    }

    const invalidHost = assignmentPlan.find((entry) => entry.nodeSlotIds.length > 0 && !entry.host);
    if (invalidHost) {
      await queueJarvisMessage(`I still need a host for ${invalidHost.deviceLabel} before I can apply the plan.`);
      return;
    }

    const nodeSlotMappings = assignmentPlan.flatMap((entry) =>
      entry.nodeSlotIds.map((nodeSlotId) => ({
        node_slot_id: nodeSlotId,
        host: entry.host,
        ssh_user: defaults.sshUser,
        ssh_port: Number(defaults.sshPort || 22),
        ssh_key_path: defaults.sshKeyPath,
        remote_dir: `${defaults.remoteRoot}/${nodeSlotId}`,
      })),
    );

    if (!nodeSlotMappings.length) {
      await queueJarvisMessage('No node mappings were generated from the current plan.');
      return;
    }

    setRunning(true);
    setHaltedAction(null);

    try {
      addTerminalLine('info', 'Generating hosts.env connection mappings...');
      const hostsPath = await invoke('agent_prepare_hosts_env', {
        input: {
          global_ssh_user: defaults.sshUser,
          global_ssh_port: Number(defaults.sshPort || 22),
          global_ssh_key_path: defaults.sshKeyPath,
          atlas_base_url: defaults.atlasBaseUrl,
          machines: nodeSlotMappings,
        },
      });

      const configuredIds = sortNodeSlotIds(nodeSlotMappings.map((entry) => entry.node_slot_id));
      setConfiguredMachineIds(configuredIds);

      addTerminalLine('success', `Connection mappings saved: ${String(hostsPath || 'updated hosts.env')}`);
      await queueJarvisMessages([
        {
          text: 'Assignment plan applied successfully.',
          typingMs: 520,
        },
        {
          text: 'Connection mappings are saved. When you are ready, I can provision and start the assigned nodes for you.',
          typingMs: 820,
        },
      ]);

      setPhase('ready_actions');
    } catch (error) {
      const reason = String(error);
      addTerminalLine('error', `Apply step failed: ${reason}`);
      await queueJarvisMessage(
        'I could not write the setup mappings. Check the terminal output, then type restart if you want to begin the setup again.',
      );
      setPhase('ready_actions');
    } finally {
      setRunning(false);
    }
  }, [addTerminalLine, assignmentPlan, defaults, queueJarvisMessage, queueJarvisMessages]);

  const runProvisionAll = useCallback(async () => {
    const targets = configuredNodeSlotIds.length
      ? configuredNodeSlotIds
      : sortNodeSlotIds(assignmentPlan.flatMap((entry) => entry.nodeSlotIds));

    if (!targets.length) {
      await queueJarvisMessage('No configured machine targets are available yet. Apply the setup plan first.');
      return;
    }

    setRunning(true);
    setHaltedAction(null);

    try {
      addTerminalLine('info', `Provisioning assigned nodes: ${targets.join(', ')}`);
      for (const nodeSlotId of targets) {
        const ok = await runSequenceForNodeSlot(nodeSlotId, PROVISION_SEQUENCE, 'Provisioning sequence');
        if (!ok) {
          addTerminalLine('error', 'Provisioning paused on failure.');
          await queueJarvisMessage('Provisioning is paused on the current failure. Resolve the recovery step and continue when ready.');
          return;
        }
      }

      addTerminalLine('success', 'Provision + start sequence completed across assigned machines.');
      await queueJarvisMessages([
        {
          text: 'Provisioning completed across the currently assigned nodes.',
          typingMs: 520,
        },
        {
          text: 'If you want to continue later, tell me "not now jarvis" and I will hand you over to the dashboard.',
          typingMs: 880,
        },
      ]);
    } finally {
      setRunning(false);
    }
  }, [addTerminalLine, assignmentPlan, configuredNodeSlotIds, queueJarvisMessage, queueJarvisMessages, runSequenceForNodeSlot]);

  const refreshFleetStatus = useCallback(async () => {
    setRunning(true);
    addTerminalLine('info', 'Refreshing fleet status snapshot...');
    try {
      const snapshot = await invoke('get_monitor_snapshot');
      const summary = {
        total: Number(snapshot?.total_nodes || 0),
        online: Number(snapshot?.online_nodes || 0),
        offline: Number(snapshot?.offline_nodes || 0),
        syncing: Number(snapshot?.syncing_nodes || 0),
        highestBlock: snapshot?.highest_block ?? 'N/A',
      };

      setSnapshotSummary(summary);
      addTerminalLine(
        'success',
        `Snapshot: online ${summary.online}/${summary.total}, offline ${summary.offline}, syncing ${summary.syncing}, highest block ${summary.highestBlock}`,
      );
      await queueJarvisMessage(
        `Fleet snapshot refreshed. Online ${summary.online}/${summary.total}, offline ${summary.offline}, syncing ${summary.syncing}, highest block ${summary.highestBlock}.`,
        'text',
        { typingMs: 720, pauseMs: 150 },
      );
    } catch (error) {
      const reason = String(error);
      addTerminalLine('error', `Snapshot refresh failed: ${reason}`);
      await queueJarvisMessage(
        'I could not refresh the fleet snapshot just now. Check the terminal output and try again in a moment.',
      );
    } finally {
      setRunning(false);
    }
  }, [addTerminalLine, queueJarvisMessage]);

  const handleResponseValue = useCallback(
    async (value) => {
      if (!value || running) {
        return;
      }

      if (isDeferCommand(value)) {
        await handoffToDashboard();
        return;
      }

      if (isRestartCommand(value)) {
        await resetWizardState();
        return;
      }

      if (phase === 'await_machine01_host') {
        setMachine01Host(value);
        setDeviceHosts([value]);
        setCurrentDeviceIndex(0);
        setPhase('await_device_count');
        addTerminalLine('info', `device-01 mapped to ${value}`);
        await queueJarvisMessage(
          'Now tell me how many physical devices you want to map in this run. Use the dropdown or type the number in chat.',
          'text',
          { typingMs: 860 },
        );
        return;
      }

      if (phase === 'await_device_count') {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > DEVNET_NODE_LAYOUT.length) {
          await queueJarvisMessage(`Enter a valid device count between 1 and ${DEVNET_NODE_LAYOUT.length}.`);
          return;
        }

        setDeviceCount(parsed);
        const nextHosts = Array.from({ length: parsed }, () => '');
        nextHosts[0] = machine01Host;
        setDeviceHosts(nextHosts);

        if (parsed === 1) {
          setPhase('review');
          addTerminalLine('info', 'Single-device topology selected.');
          await queueJarvisMessages([
            {
              text: 'Single-device plan prepared.',
              typingMs: 500,
            },
            {
              text: 'Review the assignment preview. Use Apply Plan when you want me to write the mappings, or tell me "not now jarvis" to continue later.',
              typingMs: 920,
            },
          ]);
        } else {
          setCurrentDeviceIndex(1);
          setPhase('await_device_hosts');
          addTerminalLine('info', `Planning for ${parsed} physical devices.`);
          if (parsed === 13) {
            await queueJarvisMessage(
              '13-device topology detected. I will use the fixed assignment layout for the current devnet inventory.',
              'text',
              { typingMs: 920, pauseMs: 120 },
            );
          }
          await queueJarvisMessage(
            'Enter the reachable SSH host or IP for device-02.',
            'text',
            { typingMs: 700 },
          );
        }
        return;
      }

      if (phase === 'await_device_hosts') {
        const next = [...deviceHosts];
        next[currentDeviceIndex] = value;
        setDeviceHosts(next);
        addTerminalLine('info', `device-${String(currentDeviceIndex + 1).padStart(2, '0')} mapped to ${value}`);

        const nextIndex = currentDeviceIndex + 1;
        if (nextIndex >= deviceCount) {
          setPhase('review');
          await queueJarvisMessages([
            {
              text: 'All device hosts are mapped.',
              typingMs: 520,
            },
            {
              text: 'Review the assignment preview and apply the plan when it looks right. Type restart any time if you want to begin again.',
              typingMs: 960,
            },
          ]);
        } else {
          setCurrentDeviceIndex(nextIndex);
          await queueJarvisMessage(
            `Enter the reachable SSH host or IP for device-${String(nextIndex + 1).padStart(2, '0')}.`,
            'text',
            { typingMs: 700 },
          );
        }
        return;
      }

      if (phase === 'review') {
        if (isAffirmative(value)) {
          await applyPlan();
          return;
        }

        await queueJarvisMessage(
          'Use Apply Plan to save the mappings, type restart to begin again, or tell me "not now jarvis" to continue later.',
          'text',
          { typingMs: 820 },
        );
        return;
      }

      if (phase === 'ready_actions') {
        if (isRefreshCommand(value)) {
          await refreshFleetStatus();
          return;
        }

        if (isProvisionCommand(value) || isAffirmative(value)) {
          await runProvisionAll();
          return;
        }

        await queueJarvisMessage(
          'Use the quick actions below, type "refresh status", or tell me "not now jarvis" if you want to jump to the dashboard.',
          'text',
          { typingMs: 860 },
        );
        return;
      }

      if (phase === 'error') {
        await queueJarvisMessage(
          'Type restart to try again, or use the terminal to inspect the workspace before continuing.',
          'text',
          { typingMs: 820 },
        );
      }
    },
    [
      addTerminalLine,
      applyPlan,
      currentDeviceIndex,
      deviceCount,
      deviceHosts,
      handoffToDashboard,
      machine01Host,
      phase,
      refreshFleetStatus,
      resetWizardState,
      runProvisionAll,
      running,
      queueJarvisMessage,
      queueJarvisMessages,
    ],
  );

  const submitChat = useCallback(
    async (event) => {
      event.preventDefault();
      const value = input.trim();
      if (!value || running || phase === 'booting') {
        return;
      }

      addMessage('user', value);
      setInput('');
      await handleResponseValue(value);
    },
    [addMessage, handleResponseValue, input, phase, running],
  );

  const submitChoice = useCallback(
    async (value, displayLabel = value) => {
      if (!value || running) {
        return;
      }
      addMessage('user', displayLabel);
      await handleResponseValue(value);
    },
    [addMessage, handleResponseValue, running],
  );

  const submitSelect = useCallback(
    async (event) => {
      event.preventDefault();
      if (!selectValue || running) {
        return;
      }

      const label = Number(selectValue) === 1 ? '1 physical device' : `${selectValue} physical devices`;
      addMessage('user', label);
      await handleResponseValue(selectValue);
    },
    [addMessage, handleResponseValue, running, selectValue],
  );

  const promptConfig = useMemo(() => {
    if (phase === 'await_machine01_host') {
      return {
        kind: 'text',
        hint: 'Type the reachable SSH host or IP for node-01. You can also say "not now jarvis" to skip setup for now.',
        placeholder: 'Enter SSH host or IP for node-01',
      };
    }

    if (phase === 'await_device_count') {
      return {
        kind: 'select',
        hint: 'Select the number of physical devices you want to map in this setup run.',
        options: Array.from({ length: maxDeviceCount }, (_, index) => ({
          value: String(index + 1),
          label: `${index + 1} ${index === 0 ? 'device' : 'devices'}`,
        })),
        placeholder: 'You can still type the number in chat if you prefer.',
      };
    }

    if (phase === 'await_device_hosts') {
      return {
        kind: 'text',
        hint: `Type the reachable SSH host or IP for device-${String(currentDeviceIndex + 1).padStart(2, '0')}.`,
        placeholder: `Enter SSH host or IP for device-${String(currentDeviceIndex + 1).padStart(2, '0')}`,
      };
    }

    if (phase === 'review') {
      return {
        kind: 'choices',
        hint: 'Apply the plan when it looks right. Type restart to begin again, or say "not now jarvis" to continue later.',
        options: [
          { value: 'apply plan', label: 'Apply Plan' },
          { value: 'not now jarvis', label: 'Not Now' },
        ],
        placeholder: 'Type a message or a command for Setup Assistant...',
      };
    }

    if (phase === 'ready_actions') {
      return {
        kind: 'choices',
        hint: 'Refresh the fleet snapshot, provision the assigned nodes, or tell Jarvis "not now jarvis" to open the dashboard.',
        options: [
          { value: 'refresh status', label: 'Refresh Status' },
          { value: 'provision assigned nodes', label: 'Provision + Start' },
          { value: 'not now jarvis', label: 'Go To Dashboard' },
        ],
        placeholder: 'Type a message or a command for Setup Assistant...',
      };
    }

    if (phase === 'error') {
      return {
        kind: 'text',
        hint: 'Type restart to retry the setup, or use the terminal below to inspect the environment first.',
        placeholder: 'Type restart or another command for Jarvis',
      };
    }

    return {
      kind: 'none',
      hint: 'Jarvis is preparing the setup conversation.',
      placeholder: 'Setup Assistant is warming up...',
    };
  }, [currentDeviceIndex, maxDeviceCount, phase]);

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

  const machinePlanLines = assignmentPlan
    .filter((entry) => entry.nodeSlotIds.length > 0)
    .map((entry) => {
      const roleSummary = entry.nodeSlotIds
        .map((nodeSlotId) => {
          const machine = inventoryByNodeSlotId.get(nodeSlotId);
          if (!machine) return nodeSlotId;
          return `${nodeSlotId} (${machine.role}/${machine.node_type})`;
        })
        .join(', ');
      return `${entry.deviceLabel} [${entry.host || 'missing-host'}] -> ${roleSummary}`;
    });

  const nextActionSummary = useMemo(() => phaseDetailText(phase, currentDeviceIndex), [currentDeviceIndex, phase]);

  const statusItems = [
    { label: 'Workspace', value: workspacePath || 'Not initialized' },
    { label: 'Phase', value: PHASE_LABELS[phase] || phase },
    { label: 'Inventory', value: `${inventory.length} node slots loaded` },
    {
      label: 'Machine map',
      value: deviceCount > 0 ? `${deviceHosts.filter(Boolean).length}/${deviceCount} hosts captured` : 'Waiting for inputs',
    },
    {
      label: 'Configured nodes',
      value: configuredNodeSlotIds.length ? configuredNodeSlotIds.join(', ') : 'No mappings written yet',
    },
  ];

  return (
    <section className={`jarvis-shell ${shellReady ? 'is-ready' : ''}`}>
      <div className="jarvis-layout">
        <article className="jarvis-chat-stage">
          <div className="jarvis-panel-header">
            <div>
              <h2>Setup Assistant</h2>
            </div>
            <div className={`jarvis-phase-chip ${running ? 'is-active' : ''}`}>{PHASE_LABELS[phase] || phase}</div>
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
                  <span className="jarvis-chat-author">Jarvis</span>
                  <div className="jarvis-typing-indicator" aria-label="Jarvis is typing">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              ) : null}

              <div ref={messagesEndRef} />
            </div>

            <div className="jarvis-chat-controls">
              {promptConfig.kind === 'choices' ? (
                <div className="jarvis-choice-list">
                  {promptConfig.options.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="jarvis-choice-pill"
                      onClick={() => submitChoice(option.value, option.label)}
                      disabled={running}
                    >
                      {option.label}
                    </button>
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
                  <button type="submit" className="monitor-btn monitor-btn-primary" disabled={running || !selectValue}>
                    Submit
                  </button>
                </form>
              ) : null}

              <p className="jarvis-chat-hint">{promptConfig.hint}</p>

              <form className="jarvis-chat-form" onSubmit={submitChat}>
                <input
                  type="text"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder={promptConfig.placeholder || 'Type a message for Setup Assistant...'}
                  disabled={running || phase === 'booting'}
                />
                <button
                  type="submit"
                  className="monitor-btn monitor-btn-primary"
                  disabled={running || phase === 'booting' || !input.trim()}
                >
                  Send
                </button>
              </form>
            </div>
          </div>
        </article>

        <aside className="jarvis-side-stage">
          <section className="jarvis-detail-card">
            <div className="jarvis-detail-header">
              <h3>Setup status</h3>
              <span>{running ? 'Working' : 'Standing by'}</span>
            </div>
            <p className="jarvis-detail-copy">{nextActionSummary}</p>
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
              <h3>Deployment defaults</h3>
              <span>Applied to new mappings</span>
            </div>
            <div className="jarvis-defaults-grid">
              <label>
                <span>SSH user</span>
                <input
                  value={defaults.sshUser}
                  onChange={(event) => setDefaults((prev) => ({ ...prev, sshUser: event.target.value }))}
                  placeholder="SSH user"
                  disabled={running}
                />
              </label>
              <label>
                <span>SSH port</span>
                <input
                  value={defaults.sshPort}
                  onChange={(event) => setDefaults((prev) => ({ ...prev, sshPort: event.target.value }))}
                  placeholder="SSH port"
                  disabled={running}
                />
              </label>
              <label>
                <span>SSH key path</span>
                <input
                  value={defaults.sshKeyPath}
                  onChange={(event) => setDefaults((prev) => ({ ...prev, sshKeyPath: event.target.value }))}
                  placeholder="SSH key path"
                  disabled={running}
                />
              </label>
              <label>
                <span>Remote root</span>
                <input
                  value={defaults.remoteRoot}
                  onChange={(event) => setDefaults((prev) => ({ ...prev, remoteRoot: event.target.value }))}
                  placeholder="Remote node root"
                  disabled={running}
                />
              </label>
              <label className="is-wide">
                <span>Atlas base URL</span>
                <input
                  value={defaults.atlasBaseUrl}
                  onChange={(event) => setDefaults((prev) => ({ ...prev, atlasBaseUrl: event.target.value }))}
                  placeholder="Atlas base URL"
                  disabled={running}
                />
              </label>
            </div>
          </section>

          <section className="jarvis-detail-card">
            <div className="jarvis-detail-header">
              <h3>Assignment preview</h3>
              <span>{machinePlanLines.length ? `${machinePlanLines.length} mapped devices` : 'No mappings yet'}</span>
            </div>
            <div className="jarvis-plan-list">
              {machinePlanLines.length ? (
                machinePlanLines.map((line) => <p key={line}>{line}</p>)
              ) : (
                <p>Follow the chat prompts to build the device-to-node assignment plan.</p>
              )}
            </div>
          </section>

          {snapshotSummary ? (
            <section className="jarvis-detail-card">
              <div className="jarvis-detail-header">
                <h3>Fleet snapshot</h3>
                <span>Latest refresh</span>
              </div>
              <div className="jarvis-status-list">
                <div className="jarvis-status-row">
                  <span>Online</span>
                  <strong>
                    {snapshotSummary.online}/{snapshotSummary.total}
                  </strong>
                </div>
                <div className="jarvis-status-row">
                  <span>Offline</span>
                  <strong>{snapshotSummary.offline}</strong>
                </div>
                <div className="jarvis-status-row">
                  <span>Syncing</span>
                  <strong>{snapshotSummary.syncing}</strong>
                </div>
                <div className="jarvis-status-row">
                  <span>Highest block</span>
                  <strong>{snapshotSummary.highestBlock}</strong>
                </div>
              </div>
            </section>
          ) : null}

          {haltedAction ? (
            <section className="jarvis-detail-card jarvis-detail-card-alert">
              <div className="jarvis-detail-header">
                <h3>Manual recovery</h3>
                <span>Action paused</span>
              </div>
              <p className="jarvis-detail-copy">
                {haltedAction.nodeSlotId}
                {' / '}
                {haltedAction.action}
              </p>
              <p className="jarvis-detail-copy">{haltedAction.reason}</p>
              {haltedAction.command ? <pre className="jarvis-command-preview">{haltedAction.command}</pre> : null}
              <div className="jarvis-recovery-actions">
                <button
                  className="monitor-btn"
                  onClick={async () => {
                    setRunning(true);
                    const ok = await runNodeAction(haltedAction.nodeSlotId, haltedAction.action);
                    if (ok) {
                      setHaltedAction(null);
                      await queueJarvisMessage('Retry succeeded. We can continue from here.', 'text', {
                        typingMs: 420,
                      });
                    }
                    setRunning(false);
                  }}
                  disabled={running}
                >
                  Retry In App
                </button>
                <button
                  className="monitor-btn"
                  onClick={async () => {
                    setHaltedAction(null);
                    addTerminalLine('info', 'Manual recovery acknowledged by the operator.');
                    await queueJarvisMessage('Manual step acknowledged. I will hold the current state and continue when you are ready.', 'text', {
                      typingMs: 640,
                    });
                  }}
                  disabled={running}
                >
                  I Ran It Manually
                </button>
              </div>
            </section>
          ) : null}
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
            placeholder="Run command (example: whoami)"
            disabled={terminalBusy}
          />
          <button className="monitor-btn" type="submit" disabled={terminalBusy || !terminalInput.trim()}>
            Run
          </button>
        </form>
      </div>
    </section>
  );
}

export default JarvisAgentSetup;
