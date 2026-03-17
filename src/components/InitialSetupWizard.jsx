import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '../lib/desktopClient';

const IS_WINDOWS_HOST = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent || '');

const STEPS = [
  { id: 1, title: 'Operator Profile' },
  { id: 2, title: 'SSH Key Commands' },
  { id: 3, title: 'SSH Profile' },
  { id: 4, title: 'SSH Binding' },
  { id: 5, title: 'Node Setup' },
  { id: 6, title: 'Finish' },
];

const AUTOPILOT_PLAN = [
  { key: 'workspace', label: 'Initialize Workspace' },
  { key: 'topology', label: 'Apply 13-Machine Devnet Topology' },
  { key: 'username', label: 'Detect Local Username' },
  { key: 'sshkey', label: 'Create SSH Key (if missing)' },
  { key: 'operator', label: 'Save Active Operator' },
  { key: 'sshprofile', label: 'Save SSH Profile' },
  { key: 'binding', label: 'Bind Logical Nodes To VPN IP' },
  { key: 'installers', label: 'Run Local Node Installers' },
  { key: 'validation', label: 'Validate Installed Node Registration' },
  { key: 'complete', label: 'Mark Setup Complete' },
];

const AUTOPILOT_STEP_PAUSE_MS = 520;
const AUTOPILOT_NODE_PAUSE_MS = 320;
const AUTOPILOT_RUN_START_PAUSE_MS = 260;

function newAutopilotSteps() {
  return AUTOPILOT_PLAN.map((entry) => ({
    ...entry,
    status: 'pending',
    detail: '',
  }));
}

function nowLabel() {
  return new Date().toLocaleTimeString();
}

function numericOrdinal(value) {
  const match = String(value || '').match(/(\d+)/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function sortMachineIds(machineIds) {
  return [...machineIds].sort((left, right) => {
    const leftOrdinal = numericOrdinal(left);
    const rightOrdinal = numericOrdinal(right);
    if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;
    return String(left).localeCompare(String(right));
  });
}

function sortNodeSlotIds(nodeSlotIds) {
  return sortMachineIds(nodeSlotIds);
}

function normalizeOutputLines(value) {
  const lines = String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  return lines;
}

function toLogicalNodeLabel(machineId) {
  const value = toCanonicalMachineId(machineId);
  if (!value) return '';
  return value.replace(/^machine-/i, 'node-');
}

function formatLogicalNodeList(machineIds) {
  return (Array.isArray(machineIds) ? machineIds : [])
    .map((machineId) => toLogicalNodeLabel(machineId))
    .filter(Boolean)
    .join(', ');
}

function isBootstrapValidatorLogicalNode(logicalNode) {
  return String(logicalNode?.roleGroup || '').trim().toLowerCase() === 'consensus'
    && String(logicalNode?.nodeType || '').trim().toLowerCase() === 'validator';
}

function recommendedSetupNodeIdsForMachine(machineEntry) {
  if (!machineEntry) return [];

  const validatorNodeIds = (Array.isArray(machineEntry.logicalNodes) ? machineEntry.logicalNodes : [])
    .filter((logicalNode) => isBootstrapValidatorLogicalNode(logicalNode))
    .map((logicalNode) => logicalNode.machineId);

  if (validatorNodeIds.length > 0) {
    return sortNodeSlotIds(validatorNodeIds);
  }

  return sortNodeSlotIds(machineEntry.logicalNodeIds || []);
}

function toCanonicalMachineId(value, fallback = '') {
  const normalize = (candidate) => {
    const parsed = String(candidate || '').trim().toLowerCase();
    if (!parsed) return '';
    if (parsed.startsWith('[object ') && parsed.endsWith(']')) return '';
    return parsed;
  };

  const direct = normalize(value);
  if (direct) return direct;

  if (value && typeof value === 'object') {
    const objectCandidates = [
      value.node_slot_id,
      value.machineId,
      value.physical_machine_id,
      value.physicalMachineId,
      value.value,
      value.id,
      value.target?.value,
    ];
    for (const candidate of objectCandidates) {
      const resolved = normalize(candidate);
      if (resolved) return resolved;
    }
  }

  return normalize(fallback);
}

function titleCaseLabel(value) {
  return String(value || '')
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildInventoryTopology(inventoryRows) {
  const grouped = new Map();

  (Array.isArray(inventoryRows) ? inventoryRows : []).forEach((entry) => {
    const machineId = toCanonicalMachineId(entry?.physical_machine_id, entry?.node_slot_id);
    const nodeSlotId = toCanonicalMachineId(entry?.node_slot_id);
    if (!machineId || !nodeSlotId) return;

    const existing = grouped.get(machineId) || {
      machineId,
      owner: '',
      device: '',
      os: '',
      vpnIp: '',
      publicIp: '',
      localIp: '',
      logicalNodes: [],
    };

    const vpnIp = String(entry?.vpn_ip || '').trim();
    const host = String(entry?.host || '').trim();
    if (!existing.vpnIp) {
      existing.vpnIp = vpnIp || (host.startsWith('10.50.0.') ? host : '');
    }
    if (!existing.owner) existing.owner = String(entry?.operator || '').trim();
    if (!existing.device) existing.device = String(entry?.device || '').trim();
    if (!existing.os) existing.os = String(entry?.operating_system || '').trim();
    if (!existing.publicIp) existing.publicIp = String(entry?.public_ip || '').trim();
    if (!existing.localIp) existing.localIp = String(entry?.local_ip || '').trim();

    existing.logicalNodes.push({
      machineId: nodeSlotId,
      role: titleCaseLabel(entry?.role || entry?.node_type || entry?.role_group || 'node'),
      roleGroup: String(entry?.role_group || '').trim(),
      nodeType: String(entry?.node_type || '').trim(),
      p2pPort: entry?.p2p_port,
      rpcPort: entry?.rpc_port,
      wsPort: entry?.ws_port,
    });

    grouped.set(machineId, existing);
  });

  return sortMachineIds([...grouped.keys()]).map((machineId) => {
    const entry = grouped.get(machineId);
    const logicalNodes = sortNodeSlotIds(entry.logicalNodes.map((node) => node.machineId))
      .map((nodeSlotId) => entry.logicalNodes.find((node) => node.machineId === nodeSlotId))
      .filter(Boolean);

    return {
      ...entry,
      owner: entry.owner || 'TBD',
      logicalNodes,
      logicalNodeIds: logicalNodes.map((node) => node.machineId),
      primaryRole: logicalNodes[0]?.role || '',
      secondaryRole: logicalNodes[1]?.role || '',
    };
  });
}

function newLogicalNodeStates(logicalNodeIds = []) {
  return sortNodeSlotIds(logicalNodeIds).reduce((acc, machineId) => {
    acc[machineId] = {
      status: 'idle',
      detail: 'not scheduled',
      updated_at: Date.now(),
    };
    return acc;
  }, {});
}

function sleep(ms) {
  const waitMs = Number(ms || 0);
  if (!waitMs) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    window.setTimeout(resolve, waitMs);
  });
}

function joinWorkspacePath(basePath, ...segments) {
  const normalizedBase = String(basePath || '').trim();
  if (!normalizedBase) return '';

  const separator = IS_WINDOWS_HOST ? '\\' : '/';
  const parts = [normalizedBase, ...segments]
    .map((part, index) => {
      const value = String(part || '');
      if (!value) return '';
      if (index === 0) {
        return value.replace(/[\\/]+$/g, '');
      }
      return value.replace(/^[\\/]+|[\\/]+$/g, '');
    })
    .filter(Boolean);

  return parts.join(separator);
}

function buildSshKeySetupCommand() {
  if (IS_WINDOWS_HOST) {
    return [
      'powershell -NoProfile -ExecutionPolicy Bypass -Command',
      `"`,
      "$ErrorActionPreference='Stop';",
      "New-Item -ItemType Directory -Force -Path 'keys/ssh' | Out-Null;",
      "if (-not (Test-Path 'keys/ssh/ops_ed25519')) {",
      "& ssh-keygen -t ed25519 -a 64 -f 'keys/ssh/ops_ed25519' -C 'devnet-ops' -N '';",
      "} else {",
      "Write-Output 'SSH key already exists; skipping generation.';",
      "}",
      "Get-ChildItem 'keys/ssh' -Force | Format-Table -AutoSize Name,Length,LastWriteTime",
      `"`,
    ].join(' ');
  }

  return [
    'mkdir -p keys/ssh',
    'if [ ! -f keys/ssh/ops_ed25519 ]; then ssh-keygen -t ed25519 -a 64 -f keys/ssh/ops_ed25519 -C "devnet-ops" -N ""; else echo "SSH key already exists; skipping generation."; fi',
    'ls -lah keys/ssh',
  ].join(' && ');
}

function buildListSshKeysCommand() {
  if (IS_WINDOWS_HOST) {
    return 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem \'keys/ssh\' -Force | Format-Table -AutoSize Name,Length,LastWriteTime"';
  }
  return 'ls -lah keys/ssh';
}

function buildInstallerCommand(installersRoot, logicalMachineId) {
  return buildNodeCtlCommand(installersRoot, logicalMachineId, 'setup');
}

function buildNodeCtlCommand(installersRoot, logicalMachineId, action) {
  if (IS_WINDOWS_HOST) {
    const nodeCtlScript = joinWorkspacePath(installersRoot, logicalMachineId, 'nodectl.ps1');
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${nodeCtlScript}" ${action}`;
  }
  const nodeCtlScript = joinWorkspacePath(installersRoot, logicalMachineId, 'nodectl.sh');
  return `bash "${nodeCtlScript}" ${action}`;
}

function InitialSetupWizard({ onComplete }) {
  const terminalScrollRef = useRef(null);

  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');

  const [workspacePath, setWorkspacePath] = useState('');
  const [securityState, setSecurityState] = useState(null);
  const [inventoryMachines, setInventoryMachines] = useState([]);
  const [agentSnapshot, setAgentSnapshot] = useState(null);
  const [lastWhoami, setLastWhoami] = useState('');

  const [operatorForm, setOperatorForm] = useState({
    operator_id: 'ops_lead',
    display_name: 'Ops Lead',
    role: 'admin',
  });
  const [sshProfileForm, setSshProfileForm] = useState({
    profile_id: 'ops',
    label: 'Ops SSH Profile',
    ssh_user: '',
    ssh_port: '22',
    ssh_key_path: '',
    remote_root: '/opt/synergy',
  });
  const [bindingForm, setBindingForm] = useState({
    node_slot_id: '',
    profile_id: 'ops',
    host_override: '',
    remote_dir_override: '',
  });
  const [lockedPhysicalMachineId, setLockedPhysicalMachineId] = useState('');
  const [selectedPhysicalMachine, setSelectedPhysicalMachine] = useState('');
  const [selectedSetupNodeIds, setSelectedSetupNodeIds] = useState([]);
  const [nodeSetupBusy, setNodeSetupBusy] = useState(false);
  const [nodeSetupSummary, setNodeSetupSummary] = useState('');

  const [autopilotBusy, setAutopilotBusy] = useState(false);
  const [autopilotSteps, setAutopilotSteps] = useState(() => newAutopilotSteps());
  const [autopilotProgress, setAutopilotProgress] = useState(0);
  const [autopilotSummary, setAutopilotSummary] = useState('');
  const [vpnDetectionMessage, setVpnDetectionMessage] = useState('');
  const [autopilotCurrentStepLabel, setAutopilotCurrentStepLabel] = useState('');
  const [autopilotCurrentCommand, setAutopilotCurrentCommand] = useState('');
  const [logicalNodeStates, setLogicalNodeStates] = useState(() => newLogicalNodeStates());

  const [terminalCwd, setTerminalCwd] = useState('');
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalLines, setTerminalLines] = useState([]);

  const addTerminalLine = (kind, text) => {
    if (!String(text || '').trim()) return;
    setTerminalLines((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        kind,
        text: String(text),
        at: nowLabel(),
      },
    ]);
  };

  const updateAutopilotStep = (key, status, detail = '') => {
    setAutopilotSteps((prev) =>
      prev.map((entry) => (entry.key === key ? { ...entry, status, detail } : entry)),
    );
  };

  useEffect(() => {
    terminalScrollRef.current?.scrollTo({
      top: terminalScrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [terminalLines]);

  const refreshSecurityState = async () => {
    const data = await invoke('get_monitor_security_state');
    setSecurityState(data);
    return data;
  };

  useEffect(() => {
    const initialize = async () => {
      setLoading(true);
      setError('');
      try {
        await invoke('monitor_initialize_workspace');
        const [workspace, state, inventory, agentData] = await Promise.all([
          invoke('get_monitor_workspace_path'),
          refreshSecurityState(),
          invoke('agent_get_inventory_machines'),
          invoke('get_monitor_agent_snapshot').catch(() => null),
        ]);

        const resolvedWorkspace = String(workspace || '');
        const inventoryRows = Array.isArray(inventory) ? inventory : [];
        const topologyRows = buildInventoryTopology(inventoryRows);
        const topologyMap = topologyRows.reduce((acc, entry) => {
          acc[entry.machineId] = entry;
          return acc;
        }, {});
        const nodeToMachineMap = topologyRows.reduce((acc, entry) => {
          entry.logicalNodeIds.forEach((nodeId) => {
            acc[nodeId] = entry.machineId;
          });
          return acc;
        }, {});

        setWorkspacePath(resolvedWorkspace);
        setTerminalCwd(resolvedWorkspace);
        setInventoryMachines(inventoryRows);
        setAgentSnapshot(agentData);

        const topologyMessage = await invoke('monitor_apply_devnet_topology');
        addTerminalLine('success', String(topologyMessage || 'Applied topology mapping.'));

        const identity = await invoke('monitor_detect_local_vpn_identity');
        const detectedMachine = toCanonicalMachineId(identity?.physical_machine_id);
        if (identity?.detected && detectedMachine) {
          const detectedVpnIp =
            String(identity?.vpn_ip || '').trim() || topologyMap[detectedMachine]?.vpnIp || '';

          setLockedPhysicalMachineId(detectedMachine);
          setSelectedPhysicalMachine(detectedMachine);
          setSelectedSetupNodeIds([]);
          setBindingForm((prev) => ({
            ...prev,
            node_slot_id: detectedMachine,
            host_override: detectedVpnIp || prev.host_override,
          }));
          setVpnDetectionMessage(
            `Detected ${detectedMachine} from VPN IP ${detectedVpnIp}. Choose one node slot to install on this machine before running setup.`,
          );
          addTerminalLine(
            'success',
            `Auto-detected ${detectedMachine} from VPN IP ${detectedVpnIp}. Select one node slot, then start setup.`,
          );
          setStep(5);
        } else {
          setLockedPhysicalMachineId('');
          const existingBindings = Array.isArray(state?.ssh_bindings) ? state.ssh_bindings : [];
          const inferredMachine = existingBindings.reduce((found, binding) => {
            if (found) return found;
            return nodeToMachineMap[String(binding?.node_slot_id || '').toLowerCase()] || null;
          }, null);

          if (inferredMachine) {
            const vpnIp = topologyMap[inferredMachine]?.vpnIp || '';
            setSelectedPhysicalMachine(inferredMachine);
            setSelectedSetupNodeIds([]);
            setBindingForm((prev) => ({
              ...prev,
              node_slot_id: inferredMachine,
              host_override: vpnIp || prev.host_override,
            }));
            const message = `VPN not detected. Inferred ${inferredMachine} from existing SSH bindings — ready to resume setup.`;
            setVpnDetectionMessage(message);
            addTerminalLine('info', message);
            setStep(5);
          } else {
            const message = String(identity?.message || 'VPN machine auto-detection unavailable. Select machine manually.');
            setVpnDetectionMessage(message);
            addTerminalLine('info', message);
          }
        }

        const defaultKeyPath = joinWorkspacePath(resolvedWorkspace, 'keys', 'ssh', 'ops_ed25519');
        setSshProfileForm((prev) => ({
          ...prev,
          ssh_key_path: defaultKeyPath,
          ssh_user: prev.ssh_user || 'ops',
          remote_root: String(prev.remote_root || '').trim() || '/opt/synergy',
        }));

        const activeOperator = (state?.operators || []).find((entry) => entry.operator_id === state?.active_operator_id);
        if (activeOperator) {
          setOperatorForm({
            operator_id: activeOperator.operator_id,
            display_name: activeOperator.display_name,
            role: activeOperator.role,
          });
        }

        addTerminalLine('info', 'Setup terminal ready. Autonomous setup will print each command/result here.');
        addTerminalLine('info', `Working directory: ${resolvedWorkspace}`);
      } catch (setupError) {
        setError(String(setupError));
      } finally {
        setLoading(false);
      }
    };

    initialize();
  }, []);

  const machineTopologyRows = useMemo(
    () => buildInventoryTopology(inventoryMachines),
    [inventoryMachines],
  );
  const machineTopologyMap = useMemo(
    () =>
      machineTopologyRows.reduce((acc, entry) => {
        acc[entry.machineId] = entry;
        return acc;
      }, {}),
    [machineTopologyRows],
  );
  const machineOptions = useMemo(
    () => machineTopologyRows.map((entry) => entry.machineId),
    [machineTopologyRows],
  );
  const sshProfiles = securityState?.ssh_profiles || [];
  const machineBindings = securityState?.ssh_bindings || [];
  const recentSetupLines = useMemo(() => terminalLines.slice(-8), [terminalLines]);
  const allLogicalNodes = useMemo(() => {
    const flattened = machineTopologyRows.flatMap((entry) =>
      entry.logicalNodes.map((logicalNode) => ({
        ...logicalNode,
        inventoryMachineId: entry.machineId,
      })),
    );

    return flattened.sort((left, right) => {
      const leftRecommended = isBootstrapValidatorLogicalNode(left) ? 0 : 1;
      const rightRecommended = isBootstrapValidatorLogicalNode(right) ? 0 : 1;
      if (leftRecommended !== rightRecommended) return leftRecommended - rightRecommended;
      const leftOrdinal = numericOrdinal(left.machineId);
      const rightOrdinal = numericOrdinal(right.machineId);
      if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;
      return left.machineId.localeCompare(right.machineId);
    });
  }, [machineTopologyRows]);
  const allLogicalNodeIds = useMemo(
    () => allLogicalNodes.map((entry) => entry.machineId),
    [allLogicalNodes],
  );
  const allLogicalNodeMap = useMemo(
    () =>
      allLogicalNodes.reduce((acc, logicalNode) => {
        acc[logicalNode.machineId] = logicalNode;
        return acc;
      }, {}),
    [allLogicalNodes],
  );
  const installedNodeAssignments = useMemo(() => {
    const assignments = {};
    (agentSnapshot?.agents || []).forEach((agent) => {
      if (!agent?.reachable) return;
      const machineId = toCanonicalMachineId(agent.physical_machine_id);
      (Array.isArray(agent.node_slot_ids) ? agent.node_slot_ids : []).forEach((nodeSlotId) => {
        const normalizedNodeId = toCanonicalMachineId(nodeSlotId);
        if (!normalizedNodeId) return;
        assignments[normalizedNodeId] = machineId;
      });
    });
    return assignments;
  }, [agentSnapshot]);
  const installedNodeIds = useMemo(
    () => sortNodeSlotIds(Object.keys(installedNodeAssignments)),
    [installedNodeAssignments],
  );
  const localInstalledNodeIds = useMemo(
    () =>
      sortNodeSlotIds(
        Object.entries(installedNodeAssignments)
          .filter(([, machineId]) => machineId === selectedPhysicalMachine)
          .map(([nodeSlotId]) => nodeSlotId),
      ),
    [installedNodeAssignments, selectedPhysicalMachine],
  );
  const availableSetupNodes = useMemo(
    () =>
      allLogicalNodes.filter((logicalNode) => !installedNodeAssignments[logicalNode.machineId]),
    [allLogicalNodes, installedNodeAssignments],
  );
  const recommendedSetupNodeIds = useMemo(() => {
    const recommended = availableSetupNodes
      .filter((logicalNode) => isBootstrapValidatorLogicalNode(logicalNode))
      .map((logicalNode) => logicalNode.machineId);
    if (recommended.length > 0) {
      return recommended;
    }
    return availableSetupNodes.map((logicalNode) => logicalNode.machineId);
  }, [availableSetupNodes]);
  const bootstrapValidatorNodeIds = useMemo(
    () =>
      allLogicalNodes
        .filter((logicalNode) => isBootstrapValidatorLogicalNode(logicalNode))
        .map((logicalNode) => logicalNode.machineId),
    [allLogicalNodes],
  );
  const selectedSetupNodeSet = useMemo(
    () => new Set(selectedSetupNodeIds),
    [selectedSetupNodeIds],
  );
  const selectedSetupNodes = useMemo(() => {
    return selectedSetupNodeIds
      .map((nodeSlotId) => allLogicalNodeMap[nodeSlotId])
      .filter(Boolean);
  }, [allLogicalNodeMap, selectedSetupNodeIds]);
  const selectedSetupNode = selectedSetupNodes[0] || null;
  const overlayTopologyRows = useMemo(
    () =>
      machineTopologyRows.map((entry) => ({
        ...entry,
        logicalNodes: entry.logicalNodes.map((logicalNode) => ({
          ...logicalNode,
          state: logicalNodeStates[logicalNode.machineId] || { status: 'idle', detail: 'not scheduled' },
          isTarget: selectedSetupNodeSet.has(logicalNode.machineId),
        })),
      })),
    [logicalNodeStates, machineTopologyRows, selectedSetupNodeSet],
  );

  const syncSetupSelectionForMachine = (machineId) => {
    const normalizedMachineId = toCanonicalMachineId(machineId);
    const machineEntry = machineTopologyMap[normalizedMachineId];

    setSelectedPhysicalMachine(normalizedMachineId);
    setBindingForm((prev) => ({
      ...prev,
      node_slot_id: normalizedMachineId,
      host_override: machineEntry?.vpnIp || prev.host_override,
    }));
  };

  const toggleSetupNodeSelection = (nodeSlotId) => {
    const normalizedNodeId = toCanonicalMachineId(nodeSlotId);
    if (!normalizedNodeId) return;
    setSelectedSetupNodeIds((prev) => (prev[0] === normalizedNodeId ? [] : [normalizedNodeId]));
  };

  useEffect(() => {
    if (!allLogicalNodeIds.length) return;
    setLogicalNodeStates((prev) => {
      const previous = prev || {};
      const next = newLogicalNodeStates(allLogicalNodeIds);
      allLogicalNodeIds.forEach((logicalId) => {
        if (previous[logicalId]) {
          next[logicalId] = previous[logicalId];
        }
      });
      return next;
    });
  }, [allLogicalNodeIds]);

  useEffect(() => {
    if (!selectedPhysicalMachine) return;
    const currentSelection = selectedSetupNodeIds[0];
    if (
      currentSelection
      && (
        availableSetupNodes.some((entry) => entry.machineId === currentSelection)
        || localInstalledNodeIds.includes(currentSelection)
      )
    ) {
      if (selectedSetupNodeIds.length > 1) {
        setSelectedSetupNodeIds([currentSelection]);
      }
      return;
    }

    const fallbackNodeId = recommendedSetupNodeIds[0]
      || availableSetupNodes[0]?.machineId
      || localInstalledNodeIds[0]
      || '';
    setSelectedSetupNodeIds(fallbackNodeId ? [fallbackNodeId] : []);
  }, [availableSetupNodes, localInstalledNodeIds, recommendedSetupNodeIds, selectedPhysicalMachine, selectedSetupNodeIds]);

  const setLogicalNodeState = (machineId, status, detail = '') => {
    setLogicalNodeStates((prev) => ({
      ...prev,
      [machineId]: {
        status,
        detail,
        updated_at: Date.now(),
      },
    }));
  };

  const resetLogicalNodeStateForMachine = (machineId, targetNodes) => {
    const targetSet = new Set(targetNodes);
    setLogicalNodeStates(() =>
      allLogicalNodeIds.reduce((acc, logicalId) => {
        acc[logicalId] = {
          status: targetSet.has(logicalId) ? 'pending' : 'idle',
          detail: targetSet.has(logicalId) ? `queued for ${machineId}` : 'not scheduled',
          updated_at: Date.now(),
        };
        return acc;
      }, {}),
    );
  };

  const executeCommandAndLog = async (command, cwdOverride = null) => {
    const effectiveCwd = cwdOverride || terminalCwd || workspacePath || null;
    const promptPrefix = effectiveCwd || '~';
    addTerminalLine('prompt', `${promptPrefix} $ ${command}`);
    setAutopilotCurrentCommand(command);
    try {
      const result = await invoke('monitor_run_terminal_command', {
        command,
        cwd: effectiveCwd,
      });

      if (result.cwd) {
        setTerminalCwd(String(result.cwd));
      }

      const stdoutLines = normalizeOutputLines(result.stdout);
      const stderrLines = normalizeOutputLines(result.stderr);
      stdoutLines.forEach((line) => addTerminalLine('output', line));
      stderrLines.forEach((line) => addTerminalLine('error', line));

      return result;
    } finally {
      setAutopilotCurrentCommand('');
    }
  };

  const runStrictCommand = async (command, cwdOverride = null) => {
    const result = await executeCommandAndLog(command, cwdOverride);
    if (!result.success) {
      throw new Error(result.stderr || `Command failed (exit ${result.exit_code}): ${command}`);
    }
    return result;
  };

  const runTerminalCommand = async (rawCommand) => {
    const command = String(rawCommand || '').trim();
    if (!command || terminalBusy || autopilotBusy) return;

    setTerminalBusy(true);
    try {
      if (command.toLowerCase() === 'whoami') {
        const result = await executeCommandAndLog(command, terminalCwd || null);
        const lines = normalizeOutputLines(result.stdout);
        if (result.success && lines.length > 0) {
          const detected = lines[0].trim();
          setLastWhoami(detected);
          setSshProfileForm((prev) => ({ ...prev, ssh_user: detected || prev.ssh_user }));
        }
        if (!result.success && lines.length === 0) {
          addTerminalLine('error', `Command failed with exit code ${result.exit_code}`);
        }
        return;
      }

      const result = await executeCommandAndLog(command, terminalCwd || null);
      if (!result.success && normalizeOutputLines(result.stderr).length === 0) {
        addTerminalLine('error', `Command failed with exit code ${result.exit_code}`);
      }
    } catch (runError) {
      addTerminalLine('error', String(runError));
    } finally {
      setTerminalBusy(false);
    }
  };

  const maybeStartBootstrapValidators = async () => {
    const validatorNodeIds = sortNodeSlotIds(bootstrapValidatorNodeIds);
    if (!validatorNodeIds.length) {
      return { installed: [], started: [] };
    }

    const [freshAgentSnapshot, freshSnapshot] = await Promise.all([
      invoke('get_monitor_agent_snapshot').catch(() => null),
      invoke('get_monitor_snapshot').catch(() => null),
    ]);

    if (freshAgentSnapshot) {
      setAgentSnapshot(freshAgentSnapshot);
    }

    const installedNodeSet = new Set(
      (freshAgentSnapshot?.agents || [])
        .filter((agent) => agent?.reachable)
        .flatMap((agent) => (Array.isArray(agent.node_slot_ids) ? agent.node_slot_ids : []))
        .map((nodeSlotId) => toCanonicalMachineId(nodeSlotId))
        .filter(Boolean),
    );
    const installedValidators = validatorNodeIds.filter((nodeSlotId) => installedNodeSet.has(nodeSlotId));

    if (installedValidators.length < 5) {
      addTerminalLine(
        'info',
        `Bootstrap validator quorum waiting: ${installedValidators.length}/5 installed.`,
      );
      return { installed: installedValidators, started: [] };
    }

    const onlineNodeSet = new Set(
      (freshSnapshot?.nodes || [])
        .filter((entry) => entry?.online)
        .map((entry) => toCanonicalMachineId(entry?.node?.node_slot_id))
        .filter(Boolean),
    );
    const nodesToStart = installedValidators.filter((nodeSlotId) => !onlineNodeSet.has(nodeSlotId));
    if (!nodesToStart.length) {
      addTerminalLine('success', 'Bootstrap validator quorum is already active.');
      return { installed: installedValidators, started: [] };
    }

    addTerminalLine(
      'info',
      `Bootstrap validator quorum reached. Starting ${formatLogicalNodeList(nodesToStart)} together.`,
    );
    await invoke('monitor_bulk_node_control', {
      action: 'start',
      scope: nodesToStart.join(','),
    });
    addTerminalLine(
      'success',
      `Started bootstrap validators: ${formatLogicalNodeList(nodesToStart)}.`,
    );
    return { installed: installedValidators, started: nodesToStart };
  };

  const submitTerminal = async (event) => {
    event.preventDefault();
    const command = terminalInput.trim();
    if (!command) return;
    setTerminalInput('');
    await runTerminalCommand(command);
  };

  const saveOperatorProfile = async () => {
    setError('');
    try {
      const payload = {
        operator_id: String(operatorForm.operator_id || '').trim().toLowerCase(),
        display_name: String(operatorForm.display_name || '').trim(),
        role: String(operatorForm.role || 'admin').trim().toLowerCase(),
      };
      if (!payload.operator_id || !payload.display_name) {
        throw new Error('operator_id and display_name are required.');
      }
      await invoke('monitor_upsert_operator', { input: payload });
      await invoke('monitor_set_active_operator', { operatorId: payload.operator_id });
      await refreshSecurityState();
      setStep(2);
    } catch (saveError) {
      setError(String(saveError));
    }
  };

  const saveSshProfile = async () => {
    setError('');
    try {
      const payload = {
        profile_id: String(sshProfileForm.profile_id || '').trim().toLowerCase(),
        label: String(sshProfileForm.label || '').trim(),
        ssh_user: String(sshProfileForm.ssh_user || '').trim(),
        ssh_port: Number(sshProfileForm.ssh_port || 22),
        ssh_key_path: String(sshProfileForm.ssh_key_path || '').trim() || null,
        remote_root: String(sshProfileForm.remote_root || '').trim() || '/opt/synergy',
        strict_host_key_checking: null,
        extra_ssh_args: null,
      };
      if (!payload.profile_id || !payload.label || !payload.ssh_user) {
        throw new Error('profile_id, label, and ssh_user are required.');
      }
      await invoke('monitor_upsert_ssh_profile', { input: payload });
      const updated = await refreshSecurityState();
      setBindingForm((prev) => ({
        ...prev,
        profile_id: payload.profile_id,
      }));
      if ((updated?.ssh_profiles || []).length > 0) {
        setStep(4);
      }
    } catch (saveError) {
      setError(String(saveError));
    }
  };

  const bindMachineProfile = async () => {
    setError('');
    try {
      const selectedMachine = toCanonicalMachineId(selectedPhysicalMachine, bindingForm.node_slot_id);
      const targetNodeId = toCanonicalMachineId(selectedSetupNodeIds[0]);
      const basePayload = {
        profile_id: String(bindingForm.profile_id || '').trim().toLowerCase(),
        host_override: String(bindingForm.host_override || '').trim() || null,
        remote_dir_override: String(bindingForm.remote_dir_override || '').trim() || null,
      };
      if (!selectedMachine || !basePayload.profile_id || !targetNodeId) {
        throw new Error('physical machine, node slot, and profile_id are required.');
      }
      if (lockedPhysicalMachineId && selectedMachine !== lockedPhysicalMachineId) {
        throw new Error(`This control panel is locked to ${lockedPhysicalMachineId}.`);
      }
      await invoke('monitor_assign_ssh_binding', {
        input: {
          ...basePayload,
          node_slot_id: targetNodeId,
        },
      });
      await refreshSecurityState();
      setStep(5);
    } catch (bindError) {
      setError(String(bindError));
    }
  };

  const runLocalNodeSetup = async () => {
    setError('');
    setNodeSetupBusy(true);
    setNodeSetupSummary('');
    try {
      const topologyMessage = await invoke('monitor_apply_devnet_topology');
      addTerminalLine('success', String(topologyMessage || 'Applied topology mapping.'));

      const selectedMachine = toCanonicalMachineId(selectedPhysicalMachine, bindingForm.node_slot_id);
      if (!selectedMachine) {
        throw new Error('Select the physical machine before running local node setup.');
      }
      if (lockedPhysicalMachineId && selectedMachine !== lockedPhysicalMachineId) {
        throw new Error(`This control panel is locked to ${lockedPhysicalMachineId}.`);
      }
      const targetNodeId = toCanonicalMachineId(selectedSetupNodeIds[0]);
      const targetNode = allLogicalNodeMap[targetNodeId];
      if (!targetNodeId || !targetNode) {
        throw new Error(`Select one node slot to install on ${selectedMachine}.`);
      }

      const hostOverride = String(bindingForm.host_override || '').trim() || machineTopologyMap[selectedMachine]?.vpnIp || '';
      await invoke('monitor_assign_ssh_binding', {
        input: {
          node_slot_id: targetNodeId,
          profile_id: String(bindingForm.profile_id || '').trim().toLowerCase() || 'ops',
          host_override: hostOverride || null,
          remote_dir_override: String(bindingForm.remote_dir_override || '').trim() || null,
        },
      });
      await refreshSecurityState();

      addTerminalLine('info', `Installing ${toLogicalNodeLabel(targetNodeId)} on ${selectedMachine}.`);

      const installersRoot = joinWorkspacePath(workspacePath, 'devnet', 'lean15', 'installers');
      await runStrictCommand(buildInstallerCommand(installersRoot, targetNodeId), workspacePath || null);

      let summary = `Installed ${toLogicalNodeLabel(targetNodeId)} on ${selectedMachine}.`;
      if (isBootstrapValidatorLogicalNode(targetNode)) {
        const quorumResult = await maybeStartBootstrapValidators();
        if (quorumResult.installed.length < 5) {
          summary = `${summary} Validator quorum is waiting at ${quorumResult.installed.length}/5 installed.`;
        } else if (quorumResult.started.length > 0) {
          summary = `${summary} Bootstrap validators started together after quorum was reached.`;
        }
      }
      setNodeSetupSummary(summary);
      addTerminalLine('success', summary);
    } catch (setupError) {
      setError(String(setupError));
    } finally {
      setNodeSetupBusy(false);
    }
  };

  const runAutonomousSetup = async (machineOverride = null, triggerSource = 'manual') => {
    if (autopilotBusy || nodeSetupBusy) return;

    setError('');
    setAutopilotSummary('');
    setAutopilotBusy(true);
    setAutopilotProgress(0);
    setAutopilotSteps(newAutopilotSteps());
    setAutopilotCurrentStepLabel('Preparing setup run...');
    setAutopilotCurrentCommand('');

    let completed = 0;
    const total = AUTOPILOT_PLAN.length;
    let runLogicalNodes = [];

    const runStep = async (key, label, action) => {
      updateAutopilotStep(key, 'running', label);
      setAutopilotCurrentStepLabel(label);
      addTerminalLine('info', `Autopilot: ${label}`);
      try {
        await action();
        completed += 1;
        setAutopilotProgress(Math.round((completed / total) * 100));
        updateAutopilotStep(key, 'success', `${label} complete`);
        await sleep(AUTOPILOT_STEP_PAUSE_MS);
      } catch (stepError) {
        updateAutopilotStep(key, 'failed', String(stepError));
        throw stepError;
      }
    };

    try {
      await sleep(AUTOPILOT_RUN_START_PAUSE_MS);

      const selectedMachine = toCanonicalMachineId(
        machineOverride,
        selectedPhysicalMachine || bindingForm.node_slot_id,
      );
      if (!selectedMachine) {
        throw new Error('Select the physical machine (machine-01 through machine-13) before running autonomous setup.');
      }
      const targetNodes = selectedSetupNodeIds
        .map((nodeSlotId) => toCanonicalMachineId(nodeSlotId))
        .filter(Boolean)
        .slice(0, 1);
      const vpnHost = machineTopologyMap[selectedMachine]?.vpnIp || String(bindingForm.host_override || '').trim();

      if (!targetNodes.length) {
        throw new Error(`Select one node slot to install on ${selectedMachine}.`);
      }
      if (lockedPhysicalMachineId && selectedMachine !== lockedPhysicalMachineId) {
        throw new Error(`This control panel is locked to ${lockedPhysicalMachineId}.`);
      }
      if (!vpnHost) {
        throw new Error(`No VPN IP mapping found for ${selectedMachine}`);
      }

      setSelectedPhysicalMachine(selectedMachine);
      setBindingForm((prev) => ({
        ...prev,
        node_slot_id: selectedMachine,
        host_override: vpnHost,
      }));
      resetLogicalNodeStateForMachine(selectedMachine, targetNodes);
      runLogicalNodes = targetNodes;
      addTerminalLine('info', `Autopilot trigger: ${triggerSource}. Target machine: ${selectedMachine}. Selected node: ${formatLogicalNodeList(targetNodes)}.`);

      let resolvedWorkspace = workspacePath;
      let desiredKeyPath = joinWorkspacePath(workspacePath, 'keys', 'ssh', 'ops_ed25519');
      let detectedUser = String(sshProfileForm.ssh_user || '').trim();

      await runStep('workspace', 'Initialize workspace', async () => {
        const workspace = await invoke('monitor_initialize_workspace');
        resolvedWorkspace = String(workspace || workspacePath || '');
        if (!resolvedWorkspace) {
          throw new Error('Unable to resolve monitor workspace path.');
        }
        desiredKeyPath = joinWorkspacePath(resolvedWorkspace, 'keys', 'ssh', 'ops_ed25519');
        setWorkspacePath(resolvedWorkspace);
        setTerminalCwd(resolvedWorkspace);
      });

      await runStep('topology', 'Apply topology mapping', async () => {
        const message = await invoke('monitor_apply_devnet_topology');
        addTerminalLine('success', String(message || 'Topology applied.'));
      });

      await runStep('username', 'Detect local username', async () => {
        const result = await runStrictCommand('whoami', resolvedWorkspace || null);
        const lines = normalizeOutputLines(result.stdout);
        const username = (lines[0] || '').trim();
        if (!username) {
          throw new Error('whoami returned empty username.');
        }
        detectedUser = username;
        setLastWhoami(username);
        setSshProfileForm((prev) => ({
          ...prev,
          ssh_user: username,
        }));
      });

      await runStep('sshkey', 'Generate SSH key if missing', async () => {
        const sshKeyPath = await invoke('monitor_ensure_ssh_keypair');

        setSshProfileForm((prev) => ({
          ...prev,
          ssh_key_path: String(sshKeyPath || '').trim() || prev.ssh_key_path || desiredKeyPath,
        }));
      });

      await runStep('operator', 'Save operator profile', async () => {
        const operatorId = String(operatorForm.operator_id || '').trim().toLowerCase() || 'ops_lead';
        const displayName = String(operatorForm.display_name || '').trim() || 'Ops Lead';
        const role = String(operatorForm.role || 'admin').trim().toLowerCase() || 'admin';

        await invoke('monitor_upsert_operator', {
          input: {
            operator_id: operatorId,
            display_name: displayName,
            role,
          },
        });
        await invoke('monitor_set_active_operator', { operatorId });

        setOperatorForm({
          operator_id: operatorId,
          display_name: displayName,
          role,
        });
      });

      await runStep('sshprofile', 'Save SSH profile', async () => {
        const payload = {
          profile_id: String(sshProfileForm.profile_id || '').trim().toLowerCase() || 'ops',
          label: String(sshProfileForm.label || '').trim() || 'Ops SSH Profile',
          ssh_user: detectedUser || String(sshProfileForm.ssh_user || '').trim(),
          ssh_port: Number(sshProfileForm.ssh_port || 22),
          ssh_key_path: String(sshProfileForm.ssh_key_path || '').trim() || joinWorkspacePath(resolvedWorkspace, 'keys', 'ssh', 'ops_ed25519'),
          remote_root: String(sshProfileForm.remote_root || '').trim() || '/opt/synergy',
          strict_host_key_checking: null,
          extra_ssh_args: null,
        };

        if (!payload.ssh_user) {
          throw new Error('SSH user is empty. Run whoami or enter SSH user manually.');
        }

        await invoke('monitor_upsert_ssh_profile', { input: payload });

        setSshProfileForm((prev) => ({
          ...prev,
          ...payload,
          ssh_port: String(payload.ssh_port),
        }));
        setBindingForm((prev) => ({
          ...prev,
          profile_id: payload.profile_id,
        }));
      });

      await runStep('binding', 'Bind selected node slot', async () => {
        const profileId = String(bindingForm.profile_id || sshProfileForm.profile_id || 'ops').trim().toLowerCase();
        if (!profileId) {
          throw new Error('No SSH profile is selected for ssh binding.');
        }

        for (const logicalMachineId of targetNodes) {
          setLogicalNodeState(logicalMachineId, 'running', 'binding ssh profile');
          await invoke('monitor_assign_ssh_binding', {
            input: {
              node_slot_id: logicalMachineId,
              profile_id: profileId,
              host_override: vpnHost,
              remote_dir_override: String(bindingForm.remote_dir_override || '').trim() || null,
            },
          });
          setLogicalNodeState(logicalMachineId, 'pending', 'bound, waiting install');
          await sleep(AUTOPILOT_NODE_PAUSE_MS);
        }

        setBindingForm((prev) => ({
          ...prev,
          node_slot_id: selectedMachine,
          profile_id: profileId,
          host_override: vpnHost,
        }));
      });

      await runStep('installers', 'Run local installer scripts', async () => {
        const installersRoot = joinWorkspacePath(resolvedWorkspace, 'devnet', 'lean15', 'installers');
        for (const [index, logicalMachineId] of targetNodes.entries()) {
          updateAutopilotStep(
            'installers',
            'running',
            `Installing ${toLogicalNodeLabel(logicalMachineId)} (${index + 1}/${targetNodes.length})`,
          );
          setLogicalNodeState(logicalMachineId, 'running', 'running installer');
          try {
            await runStrictCommand(
              buildInstallerCommand(installersRoot, logicalMachineId),
              resolvedWorkspace || null,
            );
            setLogicalNodeState(logicalMachineId, 'success', 'installer complete');
            await sleep(AUTOPILOT_NODE_PAUSE_MS);
          } catch (installError) {
            setLogicalNodeState(logicalMachineId, 'failed', String(installError));
            throw installError;
          }
        }
      });

      await runStep('validation', 'Validate installed node registration', async () => {
        const snapshotData = await invoke('get_monitor_agent_snapshot');
        setAgentSnapshot(snapshotData);
        const localAgent = (snapshotData?.agents || []).find(
          (agent) => toCanonicalMachineId(agent?.physical_machine_id) === selectedMachine,
        );
        if (!localAgent?.reachable) {
          throw new Error(`Local agent is not reachable for ${selectedMachine}.`);
        }
        const installedSet = new Set(
          (Array.isArray(localAgent.node_slot_ids) ? localAgent.node_slot_ids : [])
            .map((nodeSlotId) => toCanonicalMachineId(nodeSlotId))
            .filter(Boolean),
        );
        for (const [index, logicalMachineId] of targetNodes.entries()) {
          updateAutopilotStep(
            'validation',
            'running',
            `Checking ${toLogicalNodeLabel(logicalMachineId)} (${index + 1}/${targetNodes.length})`,
          );
          setLogicalNodeState(logicalMachineId, 'running', 'running status checks');
          if (!installedSet.has(logicalMachineId)) {
            setLogicalNodeState(logicalMachineId, 'failed', 'install validation failed');
            throw new Error(`${logicalMachineId}: local agent did not report the node as installed.`);
          }
          setLogicalNodeState(logicalMachineId, 'success', 'validated');
          await sleep(AUTOPILOT_NODE_PAUSE_MS);
        }

        addTerminalLine('success', `Validation passed for ${formatLogicalNodeList(targetNodes)}`);
      });

      if (selectedSetupNode && isBootstrapValidatorLogicalNode(selectedSetupNode)) {
        await maybeStartBootstrapValidators();
      }

      await runStep('complete', 'Mark setup complete', async () => {
        await invoke('monitor_mark_setup_complete', {
          physicalMachineId: selectedMachine,
          nodeSlotIds: targetNodes,
        });
      });

      await refreshSecurityState();
      setStep(6);
      setAutopilotSummary(
        `Autonomous setup finished for ${selectedMachine}. Installed now: ${formatLogicalNodeList(targetNodes)}. Additional nodes can be claimed later from the dashboard.`,
      );
      setAutopilotCurrentStepLabel('Setup completed successfully');
      setAutopilotCurrentCommand('');
      addTerminalLine('success', `Autopilot finished for ${selectedMachine}.`);
    } catch (autopilotError) {
      setLogicalNodeStates((prev) => {
        const next = { ...prev };
        for (const logicalMachineId of runLogicalNodes) {
          const currentStatus = next?.[logicalMachineId]?.status;
          if (currentStatus === 'pending' || currentStatus === 'running') {
            next[logicalMachineId] = {
              status: 'failed',
              detail: 'setup halted',
              updated_at: Date.now(),
            };
          }
        }
        return next;
      });
      setError(String(autopilotError));
      addTerminalLine('error', `Autopilot halted: ${String(autopilotError)}`);
      setAutopilotCurrentStepLabel('Setup failed');
      setAutopilotCurrentCommand('');
    } finally {
      setAutopilotBusy(false);
    }
  };

  const manualSshKeySetupCommand = buildSshKeySetupCommand();
  const manualSshKeyListCommand = buildListSshKeysCommand();
  const workspaceCommandHint = workspacePath
    ? (IS_WINDOWS_HOST
      ? `If you leave it, return with cd /d "${workspacePath}".`
      : `If you leave it, return with cd "${workspacePath}".`)
    : '';
  const sshKeyPathPlaceholder = joinWorkspacePath(workspacePath, 'keys', 'ssh', 'ops_ed25519');

  const finalizeSetupAndEnter = async () => {
    setError('');
    try {
      await invoke('monitor_mark_setup_complete', {
        physicalMachineId: toCanonicalMachineId(selectedPhysicalMachine),
        nodeSlotIds: selectedSetupNodeIds,
      });
      onComplete();
    } catch (finalizeError) {
      setError(String(finalizeError));
    }
  };

  if (loading) {
    return (
      <section className="wizard-shell">
        <div className="loading-container">
          <div className="spinner"></div>
          <p>Preparing setup wizard...</p>
        </div>
      </section>
    );
  }

  return (
    <section className="wizard-shell">
      <div className="wizard-top">
        <article className="wizard-main-panel">
          <header className="wizard-title-block">
            <h2>Synergy Node Control Panel Setup Wizard</h2>
            <p>
              Autonomous setup is now the recommended path. It runs each setup task visibly,
              validates outcomes, and blocks dashboard access until setup is verified.
            </p>
            <p>
              Workspace:
              {' '}
              <code>{workspacePath}</code>
            </p>
          </header>

          <div className="wizard-stepper">
            {STEPS.map((entry) => (
              <div
                key={entry.id}
                className={`wizard-step-pill ${step === entry.id ? 'active' : ''} ${step > entry.id ? 'done' : ''}`}
              >
                <span>{entry.id}</span>
                <strong>{entry.title}</strong>
              </div>
            ))}
          </div>

          <div className="wizard-autopilot-card">
            <div className="wizard-autopilot-header">
              <h3>Autonomous Setup (Recommended)</h3>
              <strong>{autopilotProgress}%</strong>
            </div>
            <div className="wizard-autopilot-track">
              <div className="wizard-autopilot-fill" style={{ width: `${autopilotProgress}%` }}></div>
            </div>
            <div className="wizard-autopilot-grid">
              {autopilotSteps.map((entry) => (
                <div key={entry.key} className={`wizard-autopilot-step is-${entry.status}`}>
                  <span>{entry.label}</span>
                  <small>{entry.detail || entry.status}</small>
                </div>
              ))}
            </div>
            {vpnDetectionMessage ? <p className="wizard-note"><strong>{vpnDetectionMessage}</strong></p> : null}
            {autopilotSummary ? <p className="wizard-note"><strong>{autopilotSummary}</strong></p> : null}
            <div className="wizard-action-row">
              <button
                className="monitor-btn monitor-btn-primary"
                onClick={() => {
                  void runAutonomousSetup();
                }}
                disabled={autopilotBusy || nodeSetupBusy || !selectedPhysicalMachine || selectedSetupNodeIds.length === 0}
              >
                {autopilotBusy ? 'Autonomous Setup Running...' : 'Run Autonomous Setup'}
              </button>
              <button className="monitor-btn" onClick={() => setStep(1)} disabled={autopilotBusy}>
                Open Manual Steps
              </button>
            </div>
          </div>

          {step === 1 ? (
            <div className="wizard-section">
              <h3>Step 1: Create Active Operator</h3>
              <p>
                This operator identity controls RBAC for all start/stop/setup actions.
              </p>
              <div className="wizard-form-grid">
                <label>
                  Operator ID
                  <input
                    value={operatorForm.operator_id}
                    onChange={(event) => setOperatorForm((prev) => ({ ...prev, operator_id: event.target.value }))}
                    placeholder="ops_lead"
                  />
                </label>
                <label>
                  Display Name
                  <input
                    value={operatorForm.display_name}
                    onChange={(event) => setOperatorForm((prev) => ({ ...prev, display_name: event.target.value }))}
                    placeholder="Ops Lead"
                  />
                </label>
                <label>
                  Role
                  <select
                    value={operatorForm.role}
                    onChange={(event) => setOperatorForm((prev) => ({ ...prev, role: event.target.value }))}
                  >
                    <option value="admin">admin</option>
                    <option value="operator">operator</option>
                    <option value="viewer">viewer</option>
                  </select>
                </label>
              </div>
              <div className="wizard-action-row">
                <button className="monitor-btn monitor-btn-primary" onClick={saveOperatorProfile} disabled={autopilotBusy}>
                  Save Operator And Continue
                </button>
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="wizard-section">
              <h3>Step 2: Run SSH Setup Commands</h3>
              <p>
                Use the terminal below. If you do not know your username, run
                {' '}
                <code>whoami</code>
                .
              </p>
              <ol className="wizard-instruction-list">
                <li>Run <code>whoami</code> to detect local username (auto-fills SSH user).</li>
                <li>The setup terminal already opens in the control panel workspace. {workspaceCommandHint}</li>
                <li>Run <code>{manualSshKeySetupCommand}</code> to create the SSH key directory and generate the key when missing.</li>
                <li>Run <code>{manualSshKeyListCommand}</code> and verify private/public key files exist.</li>
              </ol>
              <div className="wizard-action-row">
                <button className="monitor-btn monitor-btn-primary" onClick={() => setStep(3)} disabled={autopilotBusy}>
                  Continue To SSH Profile
                </button>
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="wizard-section">
              <h3>Step 3: Configure SSH Profile</h3>
              <p>Recommended values are prefilled. Update only if your environment differs.</p>
              <div className="wizard-form-grid">
                <label>
                  Profile ID
                  <input
                    value={sshProfileForm.profile_id}
                    onChange={(event) => setSshProfileForm((prev) => ({ ...prev, profile_id: event.target.value }))}
                    placeholder="ops"
                  />
                </label>
                <label>
                  Label
                  <input
                    value={sshProfileForm.label}
                    onChange={(event) => setSshProfileForm((prev) => ({ ...prev, label: event.target.value }))}
                    placeholder="Ops SSH Profile"
                  />
                </label>
                <label>
                  SSH User
                  <input
                    value={sshProfileForm.ssh_user}
                    onChange={(event) => setSshProfileForm((prev) => ({ ...prev, ssh_user: event.target.value }))}
                    placeholder="ops"
                  />
                </label>
                <label>
                  SSH Port
                  <input
                    value={sshProfileForm.ssh_port}
                    onChange={(event) => setSshProfileForm((prev) => ({ ...prev, ssh_port: event.target.value }))}
                    placeholder="22"
                  />
                </label>
                <label>
                  SSH Key Path
                  <input
                    value={sshProfileForm.ssh_key_path}
                    onChange={(event) => setSshProfileForm((prev) => ({ ...prev, ssh_key_path: event.target.value }))}
                    placeholder={sshKeyPathPlaceholder}
                  />
                </label>
                <label>
                  Remote Root
                  <input
                    value={sshProfileForm.remote_root}
                    onChange={(event) => setSshProfileForm((prev) => ({ ...prev, remote_root: event.target.value }))}
                    placeholder="/opt/synergy"
                  />
                </label>
              </div>
              {lastWhoami ? (
                <p className="wizard-note">
                  Detected username from terminal:
                  {' '}
                  <strong>{lastWhoami}</strong>
                </p>
              ) : null}
              <div className="wizard-action-row">
                <button className="monitor-btn monitor-btn-primary" onClick={saveSshProfile} disabled={autopilotBusy}>
                  Save SSH Profile And Continue
                </button>
              </div>
            </div>
          ) : null}

          {step === 4 ? (
            <div className="wizard-section">
              <h3>Step 4: Bind SSH Profile To This Machine</h3>
              <p>
                Pick the physical machine you are sitting on, then bind the selected node slot to
                that machine&apos;s VPN IP. This no longer assigns every inventory row automatically.
                Machine options are loaded from
                {' '}
                <code>node-inventory.csv</code>
                . When the VPN is detected, this binding defaults to the local machine&apos;s VPN IP.
              </p>
              <div className="wizard-form-grid">
                <label>
                  Physical Machine
                  <select
                    value={bindingForm.node_slot_id}
                    disabled={Boolean(lockedPhysicalMachineId)}
                    onChange={(event) => {
                      const nextMachineId = event.target.value;
                      setBindingForm((prev) => ({
                        ...prev,
                        node_slot_id: nextMachineId,
                        host_override: machineTopologyMap[nextMachineId]?.vpnIp || prev.host_override,
                      }));
                      if (machineTopologyMap[nextMachineId]?.vpnIp) {
                        syncSetupSelectionForMachine(nextMachineId);
                      }
                    }}
                  >
                    <option value="" disabled>— Select this machine —</option>
                    {machineOptions.map((machineId) => (
                      <option key={machineId} value={machineId}>
                        {machineId}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Selected Node Slot
                  <input
                    value={selectedSetupNode ? toLogicalNodeLabel(selectedSetupNode.machineId) : ''}
                    readOnly
                    placeholder="Choose node slot in Step 5"
                  />
                </label>
                <label>
                  SSH Profile
                  <select
                    value={bindingForm.profile_id}
                    onChange={(event) => setBindingForm((prev) => ({ ...prev, profile_id: event.target.value }))}
                  >
                    {sshProfiles.map((profile) => (
                      <option key={profile.profile_id} value={profile.profile_id}>
                        {profile.profile_id}
                        {' '}
                        ({profile.ssh_user}@:{profile.ssh_port})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Host Override
                  <input
                    value={bindingForm.host_override}
                    onChange={(event) => setBindingForm((prev) => ({ ...prev, host_override: event.target.value }))}
                    placeholder="10.50.0.x"
                  />
                </label>
                <label>
                  Remote Dir Override
                  <input
                    value={bindingForm.remote_dir_override}
                    onChange={(event) => setBindingForm((prev) => ({ ...prev, remote_dir_override: event.target.value }))}
                    placeholder="/opt/synergy/node-01"
                  />
                </label>
              </div>
              {lockedPhysicalMachineId ? (
                <p className="wizard-note">
                  <strong>Machine locked:</strong>
                  {' '}
                  SSH binding is locked to
                  {' '}
                  <code>{lockedPhysicalMachineId}</code>
                  {' '}
                  because this control panel detected the local VPN identity.
                </p>
              ) : null}
              <div className="wizard-action-row">
                <button className="monitor-btn monitor-btn-primary" onClick={bindMachineProfile} disabled={autopilotBusy || !bindingForm.node_slot_id || !selectedSetupNode}>
                  Bind Selected Node Slot And Continue
                </button>
                <button className="monitor-btn" onClick={() => setStep(5)} disabled={autopilotBusy}>
                  Skip Binding And Continue
                </button>
              </div>
            </div>
          ) : null}

          {step === 5 ? (
            <div className="wizard-section">
              <h3>Step 5: Install One Node Slot</h3>
              <p>
                Initial setup installs exactly one node slot on this machine. Additional node slots
                can be claimed later from the dashboard after this machine is registered.
              </p>
              <div className="wizard-form-grid">
                <label>
                  Physical Machine
                  <select
                    value={selectedPhysicalMachine}
                    disabled={Boolean(lockedPhysicalMachineId)}
                    onChange={(event) => {
                      const nextMachineId = event.target.value;
                      syncSetupSelectionForMachine(nextMachineId);
                    }}
                  >
                    <option value="" disabled>— Select this machine —</option>
                    {machineTopologyRows.map((entry) => (
                      <option key={entry.machineId} value={entry.machineId}>
                        {entry.machineId}
                        {' '}
                        ({entry.primaryRole}
                        {entry.secondaryRole ? ` + ${entry.secondaryRole}` : ''})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Already Installed On This Machine
                  <input
                    value={formatLogicalNodeList(localInstalledNodeIds)}
                    readOnly
                  />
                </label>
                <label>
                  Selected Node Slot
                  <input
                    value={formatLogicalNodeList(selectedSetupNodeIds)}
                    readOnly
                  />
                </label>
              </div>
              {selectedPhysicalMachine ? (
                <div className="wizard-node-selection">
                  {availableSetupNodes.map((logicalNode) => {
                    const selected = selectedSetupNodeSet.has(logicalNode.machineId);
                    const recommended = recommendedSetupNodeIds.includes(logicalNode.machineId);

                    return (
                      <label
                        key={logicalNode.machineId}
                        className={`wizard-node-option ${selected ? 'is-selected' : ''} ${recommended ? 'is-recommended' : ''}`}
                      >
                        <input
                          type="radio"
                          name="initial-node-slot"
                          checked={selected}
                          onChange={() => toggleSetupNodeSelection(logicalNode.machineId)}
                        />
                        <span>
                          <strong>{toLogicalNodeLabel(logicalNode.machineId)}</strong>
                          <small>
                            {logicalNode.role}
                            {' '}
                            • inventory
                            {' '}
                            {logicalNode.inventoryMachineId}
                            {recommended ? ' • recommended for bootstrap' : ''}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
              {lockedPhysicalMachineId ? (
                <p className="wizard-note">
                  <strong>Machine locked:</strong>
                  {' '}
                  VPN detection bound this control panel to
                  {' '}
                  <code>{lockedPhysicalMachineId}</code>
                  . Node selection is flexible, machine selection is not.
                </p>
              ) : null}
              <div className="wizard-action-row">
                <button
                  className="monitor-btn"
                  onClick={() => setSelectedSetupNodeIds(recommendedSetupNodeIds[0] ? [recommendedSetupNodeIds[0]] : [])}
                  disabled={nodeSetupBusy || autopilotBusy || !selectedPhysicalMachine || recommendedSetupNodeIds.length === 0}
                >
                  Select Suggested Node
                </button>
                <button
                  className="monitor-btn"
                  onClick={() => setSelectedSetupNodeIds([])}
                  disabled={nodeSetupBusy || autopilotBusy || selectedSetupNodeIds.length === 0}
                >
                  Clear Selection
                </button>
              </div>
              {selectedSetupNodes.length > 0 ? (
                <p className="wizard-note">
                  <strong>Selected now:</strong>
                  {' '}
                  {formatLogicalNodeList(selectedSetupNodeIds)}
                </p>
              ) : (
                <p className="wizard-note">
                  <strong>Select one node slot.</strong>
                  {' '}
                  Validator-first is the recommended bootstrap path because quorum begins once five
                  bootstrap validators are installed.
                </p>
              )}
              {nodeSetupSummary ? (
                <p className="wizard-note">
                  <strong>{nodeSetupSummary}</strong>
                </p>
              ) : null}
              <p className="wizard-note">
                Bootstrap validators stay staged until five validators are installed. Non-validator
                nodes stay offline until you run the node&apos;s
                {' '}
                <strong>Sync Node</strong>
                {' '}
                action from the dashboard or node detail page.
              </p>
              <div className="wizard-action-row">
                <button
                  className="monitor-btn monitor-btn-primary"
                  onClick={runLocalNodeSetup}
                  disabled={nodeSetupBusy || autopilotBusy || !selectedPhysicalMachine || selectedSetupNodeIds.length === 0}
                >
                  {nodeSetupBusy ? 'Installing...' : 'Install Selected Node'}
                </button>
                <button className="monitor-btn" onClick={() => setStep(6)} disabled={nodeSetupBusy || autopilotBusy}>
                  Continue
                </button>
              </div>
            </div>
          ) : null}

          {step === 6 ? (
            <div className="wizard-section">
              <h3>Setup Ready</h3>
              <p>
                Entering the dashboard now requires setup completion to be marked in backend config.
                If validation fails, this screen will show the exact blocking error.
              </p>
              <p className="wizard-note">
                This machine is registered after one node slot is installed. Additional node slots
                can be claimed later from the dashboard.
              </p>
              <div className="wizard-action-row">
                <button className="monitor-btn monitor-btn-primary" onClick={finalizeSetupAndEnter}>
                  Enter Control Panel
                </button>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="monitor-error-box">
              <strong>Setup Error:</strong>
              {' '}
              {error}
            </div>
          ) : null}
        </article>

        <aside className="wizard-side-panel">
          <h3>Machine Capacity Map</h3>
          <p>
            Machine capacity still comes from
            {' '}
            <code>node-inventory.csv</code>
            , but operators now claim node slots explicitly instead of being auto-assigned to every
            slot listed for a machine.
            .
          </p>
          <div className="wizard-plan-table-wrap">
            <table className="wizard-plan-table">
              <thead>
                <tr>
                  <th>Machine</th>
                  <th>VPN IP</th>
                  <th>Primary</th>
                  <th>Secondary</th>
                </tr>
              </thead>
              <tbody>
                {machineTopologyRows.map((entry) => (
                  <tr key={entry.machineId}>
                    <td>{entry.machineId}</td>
                    <td>{entry.vpnIp}</td>
                    <td>{entry.primaryRole}</td>
                    <td>{entry.secondaryRole}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="wizard-side-notes">
            <p>
              Active operator:
              {' '}
              <strong>{securityState?.active_operator_id || 'N/A'}</strong>
            </p>
            <p>
              SSH profiles:
              {' '}
              <strong>{sshProfiles.length}</strong>
            </p>
            <p>
              Machine bindings:
              {' '}
              <strong>{machineBindings.length}</strong>
            </p>
          </div>
        </aside>
      </div>

      {autopilotBusy ? (
        <div className="wizard-setup-overlay" role="status" aria-live="polite">
          <div className="wizard-setup-overlay-card">
            <div className="wizard-setup-overlay-head">
              <h3>Autonomous Setup Running</h3>
              <strong>{autopilotProgress}%</strong>
            </div>
            <p>
              Target:
              {' '}
              <code>{selectedPhysicalMachine}</code>
              {' '}
              • Keep this window open.
            </p>
            <p>
              Current step:
              {' '}
              <strong>{autopilotCurrentStepLabel || 'Preparing...'}</strong>
            </p>
            <p>
              Current command:
              {' '}
              <code>{autopilotCurrentCommand || 'waiting...'}</code>
            </p>
            <div className="wizard-setup-overlay-track">
              <div className="wizard-setup-overlay-fill" style={{ width: `${autopilotProgress}%` }}></div>
            </div>
            <div className="wizard-setup-overlay-topology">
              <div className="wizard-setup-overlay-topology-head">
                <h4>Node-By-Node Topology Progress</h4>
                <p>Each logical node lights up as installer and validation steps complete.</p>
              </div>
              <div className="wizard-topology-physical-grid">
                {overlayTopologyRows.map((row) => (
                  <div key={row.machineId} className={`wizard-topology-physical-card ${selectedPhysicalMachine === row.machineId ? 'is-current' : ''}`}>
                    <div className="wizard-topology-physical-head">
                      <strong>{row.machineId}</strong>
                      <small>{row.vpnIp}</small>
                    </div>
                    <div className="wizard-topology-node-list">
                      {row.logicalNodes.map((logicalNode) => (
                        <div
                          key={logicalNode.machineId}
                          className={`wizard-topology-node is-${logicalNode.state.status} ${logicalNode.isTarget ? 'is-target' : ''}`}
                        >
                          <span>{toLogicalNodeLabel(logicalNode.machineId)}</span>
                          <small>{logicalNode.role}</small>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="wizard-setup-overlay-body">
              <div className="wizard-setup-overlay-steps">
                {autopilotSteps.map((entry) => (
                  <div key={entry.key} className={`wizard-setup-overlay-step is-${entry.status}`}>
                    <span>{entry.label}</span>
                    <small>{entry.detail || entry.status}</small>
                  </div>
                ))}
              </div>
              <div className="wizard-setup-overlay-events">
                {recentSetupLines.map((line) => (
                  <div key={line.id} className={`wizard-setup-overlay-event ${line.kind}`}>
                    <span>{line.at}</span>
                    <strong>{line.text}</strong>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="wizard-terminal-panel">
        <div className="wizard-terminal-header">
          <span>Setup Terminal</span>
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
            disabled={terminalBusy || autopilotBusy}
          />
          <button
            className="monitor-btn"
            type="submit"
            disabled={terminalBusy || autopilotBusy || !terminalInput.trim()}
          >
            Run
          </button>
        </form>
      </div>
    </section>
  );
}

export default InitialSetupWizard;
