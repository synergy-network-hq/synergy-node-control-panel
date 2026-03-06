import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

const MACHINE_OPTIONS = Array.from({ length: 13 }, (_, index) => `machine-${String(index + 1).padStart(2, '0')}`);

const ACTIVE_MACHINE_PLAN = [
  {
    machineId: 'machine-01',
    owner: 'Rob',
    os: 'macOS',
    vpnIp: '10.50.0.1',
    primaryRole: 'Validator',
    secondaryRole: 'VPN Hub',
    notes: 'VPN hub host. Only validator node on this device.',
  },
  {
    machineId: 'machine-02',
    owner: 'Justin',
    os: 'macOS',
    vpnIp: '10.50.0.2',
    primaryRole: 'Validator',
    secondaryRole: 'Observer',
    notes: 'Class I + Class V',
  },
  {
    machineId: 'machine-03',
    owner: 'Rob',
    os: 'macOS',
    vpnIp: '10.50.0.3',
    primaryRole: 'Validator',
    secondaryRole: 'Cross-Chain Verifier',
    notes: 'Class I + Class II',
  },
  {
    machineId: 'machine-04',
    owner: 'Justin',
    os: 'Ubuntu',
    vpnIp: '10.50.0.4',
    primaryRole: 'Validator',
    secondaryRole: 'Relayer',
    notes: 'Class I + Class II',
  },
  {
    machineId: 'machine-05',
    owner: 'Rob',
    os: 'Ubuntu',
    vpnIp: '10.50.0.5',
    primaryRole: 'Validator',
    secondaryRole: 'Committee',
    notes: 'Class I + Class I',
  },
  {
    machineId: 'machine-06',
    owner: 'Network',
    os: 'Ubuntu Server',
    vpnIp: '10.50.0.6',
    primaryRole: 'Security Council',
    secondaryRole: 'Oracle',
    notes: 'Class IV + Class II',
  },
  {
    machineId: 'machine-07',
    owner: 'Rob',
    os: 'Windows',
    vpnIp: '10.50.0.7',
    primaryRole: 'Witness',
    secondaryRole: 'RPC Gateway',
    notes: 'Class II + Class V',
  },
  {
    machineId: 'machine-08',
    owner: 'Rob',
    os: 'Windows',
    vpnIp: '10.50.0.8',
    primaryRole: 'Indexer',
    secondaryRole: 'PQC Crypto',
    notes: 'Class V + Class III',
  },
  {
    machineId: 'machine-09',
    owner: 'David',
    os: '',
    vpnIp: '10.50.0.9',
    primaryRole: 'Archive Validator',
    secondaryRole: 'Audit Validator',
    notes: 'Class I + Class I',
  },
  {
    machineId: 'machine-10',
    owner: 'Mark',
    os: '',
    vpnIp: '10.50.0.10',
    primaryRole: 'Data Availability',
    secondaryRole: '',
    notes: 'Class III. GPU node is a host capability note, not a second logical node.',
  },
  {
    machineId: 'machine-11',
    owner: 'Mark',
    os: '',
    vpnIp: '10.50.0.11',
    primaryRole: 'AI Inference',
    secondaryRole: '',
    notes: 'Class III. GPU node is a host capability note, not a second logical node.',
  },
  {
    machineId: 'machine-12',
    owner: 'Gunther',
    os: 'Ubuntu',
    vpnIp: '10.50.0.12',
    primaryRole: 'UMA Coordinator',
    secondaryRole: 'Compute',
    notes: 'Class III + Class III',
  },
  {
    machineId: 'machine-13',
    owner: 'David',
    os: '',
    vpnIp: '10.50.0.13',
    primaryRole: 'Treasury Controller',
    secondaryRole: 'Governance Auditor',
    notes: 'Class IV + Class IV',
  },
];

const PHYSICAL_TO_LOGICAL_NODE_MAP = {
  'machine-01': ['node-01'],
  'machine-02': ['node-02', 'node-03'],
  'machine-03': ['node-04', 'node-05'],
  'machine-04': ['node-06', 'node-07'],
  'machine-05': ['node-08', 'node-09'],
  'machine-06': ['node-10', 'node-11'],
  'machine-07': ['node-12', 'node-13'],
  'machine-08': ['node-14', 'node-15'],
  'machine-09': ['node-16', 'node-17'],
  'machine-10': ['node-18'],
  'machine-11': ['node-20'],
  'machine-12': ['node-22', 'node-23'],
  'machine-13': ['node-24', 'node-25'],
};

const PHYSICAL_MACHINE_VPN_IP = {
  'machine-01': '10.50.0.1',
  'machine-02': '10.50.0.2',
  'machine-03': '10.50.0.3',
  'machine-04': '10.50.0.4',
  'machine-05': '10.50.0.5',
  'machine-06': '10.50.0.6',
  'machine-07': '10.50.0.7',
  'machine-08': '10.50.0.8',
  'machine-09': '10.50.0.9',
  'machine-10': '10.50.0.10',
  'machine-11': '10.50.0.11',
  'machine-12': '10.50.0.12',
  'machine-13': '10.50.0.13',
};

const LOGICAL_NODE_METADATA = {
  'node-01': 'validator',
  'node-02': 'validator',
  'node-03': 'observer',
  'node-04': 'validator',
  'node-05': 'cross-chain-verifier',
  'node-06': 'validator',
  'node-07': 'relayer',
  'node-08': 'validator',
  'node-09': 'committee',
  'node-10': 'security-council',
  'node-11': 'oracle',
  'node-12': 'witness',
  'node-13': 'rpc-gateway',
  'node-14': 'indexer',
  'node-15': 'pqc-crypto',
  'node-16': 'archive-validator',
  'node-17': 'audit-validator',
  'node-18': 'data-availability',
  'node-20': 'ai-inference',
  'node-22': 'uma-coordinator',
  'node-23': 'compute',
  'node-24': 'treasury-controller',
  'node-25': 'governance-auditor',
};

const ALL_LOGICAL_MACHINE_IDS = Object.values(PHYSICAL_TO_LOGICAL_NODE_MAP)
  .flat()
  .filter((machineId, index, source) => source.indexOf(machineId) === index)
  .sort();

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
  { key: 'validation', label: 'Validate Node Readiness' },
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

function newLogicalNodeStates() {
  return ALL_LOGICAL_MACHINE_IDS.reduce((acc, machineId) => {
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

function InitialSetupWizard({ onComplete }) {
  const terminalScrollRef = useRef(null);

  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');

  const [workspacePath, setWorkspacePath] = useState('');
  const [securityState, setSecurityState] = useState(null);
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
  const [selectedPhysicalMachine, setSelectedPhysicalMachine] = useState('');
  const [nodeSetupBusy, setNodeSetupBusy] = useState(false);
  const [nodeSetupSummary, setNodeSetupSummary] = useState('');

  const [autopilotBusy, setAutopilotBusy] = useState(false);
  const [autopilotSteps, setAutopilotSteps] = useState(() => newAutopilotSteps());
  const [autopilotProgress, setAutopilotProgress] = useState(0);
  const [autopilotSummary, setAutopilotSummary] = useState('');
  const [autoStartMachineId, setAutoStartMachineId] = useState('');
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
        const [workspace, state] = await Promise.all([
          invoke('get_monitor_workspace_path'),
          refreshSecurityState(),
        ]);

        const resolvedWorkspace = String(workspace || '');
        setWorkspacePath(resolvedWorkspace);
        setTerminalCwd(resolvedWorkspace);

        const topologyMessage = await invoke('monitor_apply_devnet_topology');
        addTerminalLine('success', String(topologyMessage || 'Applied topology mapping.'));

        const identity = await invoke('monitor_detect_local_vpn_identity');
        const detectedMachine = toCanonicalMachineId(identity?.physical_machine_id);
        if (identity?.detected && detectedMachine) {
          const detectedVpnIp =
            String(identity?.vpn_ip || '').trim() || PHYSICAL_MACHINE_VPN_IP[detectedMachine] || '';
          const logicalNodes = Array.isArray(identity?.node_slot_ids) ? identity.node_slot_ids : [];

          setSelectedPhysicalMachine(detectedMachine);
          setBindingForm((prev) => ({
            ...prev,
            node_slot_id: detectedMachine,
            host_override: detectedVpnIp || prev.host_override,
          }));
          setVpnDetectionMessage(
            `Detected ${detectedMachine} from VPN IP ${detectedVpnIp}. Logical nodes: ${formatLogicalNodeList(logicalNodes)}`,
          );
          setAutoStartMachineId(detectedMachine);
          addTerminalLine(
            'success',
            `Auto-detected ${detectedMachine} from VPN IP ${detectedVpnIp}. Queueing autonomous setup...`,
          );
        } else {
          const message = String(identity?.message || 'VPN machine auto-detection unavailable. Select machine manually.');
          setVpnDetectionMessage(message);
          addTerminalLine('info', message);
        }

        const defaultKeyPath = `${resolvedWorkspace}/keys/ssh/ops_ed25519`;
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

  const activeMachineSet = useMemo(() => new Set(ACTIVE_MACHINE_PLAN.map((entry) => entry.machineId)), []);
  const sshProfiles = securityState?.ssh_profiles || [];
  const machineBindings = securityState?.ssh_bindings || [];
  const recentSetupLines = useMemo(() => terminalLines.slice(-8), [terminalLines]);
  const selectedLogicalNodes = useMemo(
    () => PHYSICAL_TO_LOGICAL_NODE_MAP[selectedPhysicalMachine] || [],
    [selectedPhysicalMachine],
  );
  const selectedLogicalNodeSet = useMemo(
    () => new Set(selectedLogicalNodes),
    [selectedLogicalNodes],
  );
  const overlayTopologyRows = useMemo(
    () =>
      ACTIVE_MACHINE_PLAN.map((entry) => ({
        ...entry,
        logicalNodes: (PHYSICAL_TO_LOGICAL_NODE_MAP[entry.machineId] || []).map((logicalId) => ({
          machineId: logicalId,
          role: LOGICAL_NODE_METADATA[logicalId] || 'node',
          state: logicalNodeStates[logicalId] || { status: 'idle', detail: 'not scheduled' },
          isTarget: selectedLogicalNodeSet.has(logicalId),
        })),
      })),
    [logicalNodeStates, selectedLogicalNodeSet],
  );

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
      ALL_LOGICAL_MACHINE_IDS.reduce((acc, logicalId) => {
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
      const selectedMachine = toCanonicalMachineId(bindingForm.node_slot_id);
      const logicalNodes = PHYSICAL_TO_LOGICAL_NODE_MAP[selectedMachine] || [selectedMachine];
      const basePayload = {
        profile_id: String(bindingForm.profile_id || '').trim().toLowerCase(),
        host_override: String(bindingForm.host_override || '').trim() || null,
        remote_dir_override: String(bindingForm.remote_dir_override || '').trim() || null,
      };
      if (!selectedMachine || !basePayload.profile_id) {
        throw new Error('node_slot_id and profile_id are required.');
      }

      for (const logicalMachineId of logicalNodes) {
        await invoke('monitor_assign_ssh_binding', {
          input: {
            ...basePayload,
            node_slot_id: logicalMachineId,
          },
        });
      }
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

      const selectedMachine = toCanonicalMachineId(selectedPhysicalMachine);
      const logicalNodes = PHYSICAL_TO_LOGICAL_NODE_MAP[selectedMachine] || [];
      if (logicalNodes.length === 0) {
        throw new Error(`No logical node mapping found for ${selectedMachine || String(selectedPhysicalMachine || '')}`);
      }

      const hostOverride = String(bindingForm.host_override || '').trim() || PHYSICAL_MACHINE_VPN_IP[selectedMachine] || '';
      for (const logicalMachineId of logicalNodes) {
        await invoke('monitor_assign_ssh_binding', {
          input: {
            node_slot_id: logicalMachineId,
            profile_id: String(bindingForm.profile_id || '').trim().toLowerCase() || 'ops',
            host_override: hostOverride || null,
            remote_dir_override: String(bindingForm.remote_dir_override || '').trim() || null,
          },
        });
      }
      await refreshSecurityState();

      addTerminalLine('info', `Starting local node setup for ${selectedMachine}: ${formatLogicalNodeList(logicalNodes)}`);

      const basePath = `${workspacePath}/devnet/lean15/installers`;
      for (const logicalMachineId of logicalNodes) {
        const installScript = `${basePath}/${logicalMachineId}/install_and_start.sh`;
        await runStrictCommand(`bash "${installScript}"`, workspacePath || null);
      }

      const summary = `Completed setup commands for ${selectedMachine} node slots: ${formatLogicalNodeList(logicalNodes)}`;
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

      const selectedMachine = toCanonicalMachineId(machineOverride, selectedPhysicalMachine);
      const logicalNodes = PHYSICAL_TO_LOGICAL_NODE_MAP[selectedMachine] || [];
      runLogicalNodes = logicalNodes;
      const vpnHost = PHYSICAL_MACHINE_VPN_IP[selectedMachine] || String(bindingForm.host_override || '').trim();

      if (!logicalNodes.length) {
        throw new Error(`No logical node mapping found for ${selectedMachine}`);
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
      resetLogicalNodeStateForMachine(selectedMachine, logicalNodes);
      addTerminalLine('info', `Autopilot trigger: ${triggerSource}. Target machine: ${selectedMachine}.`);

      let resolvedWorkspace = workspacePath;
      const desiredKeyPath = `${workspacePath}/keys/ssh/ops_ed25519`;
      let detectedUser = String(sshProfileForm.ssh_user || '').trim();

      await runStep('workspace', 'Initialize workspace', async () => {
        const workspace = await invoke('monitor_initialize_workspace');
        resolvedWorkspace = String(workspace || workspacePath || '');
        if (!resolvedWorkspace) {
          throw new Error('Unable to resolve monitor workspace path.');
        }
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
        const command = [
          'mkdir -p keys/ssh',
          'if [ ! -f keys/ssh/ops_ed25519 ]; then ssh-keygen -t ed25519 -a 64 -f keys/ssh/ops_ed25519 -C "devnet-ops" -N ""; else echo "SSH key already exists; skipping generation."; fi',
          'ls -lah keys/ssh',
        ].join(' && ');
        await runStrictCommand(command, resolvedWorkspace || null);

        setSshProfileForm((prev) => ({
          ...prev,
          ssh_key_path: prev.ssh_key_path || desiredKeyPath,
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
          ssh_key_path: String(sshProfileForm.ssh_key_path || '').trim() || `${resolvedWorkspace}/keys/ssh/ops_ed25519`,
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

      await runStep('binding', 'Bind mapped logical nodes', async () => {
        const profileId = String(bindingForm.profile_id || sshProfileForm.profile_id || 'ops').trim().toLowerCase();
        if (!profileId) {
          throw new Error('No SSH profile is selected for ssh binding.');
        }

        for (const logicalMachineId of logicalNodes) {
          setLogicalNodeState(logicalMachineId, 'running', 'binding ssh profile');
          await invoke('monitor_assign_ssh_binding', {
            input: {
              node_slot_id: logicalMachineId,
              profile_id: profileId,
              host_override: vpnHost,
              remote_dir_override: String(bindingForm.remote_dir_override || '').trim() || null,
            },
          });
          setLogicalNodeState(logicalMachineId, 'pending', 'bound, waiting installer');
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
        const basePath = `${resolvedWorkspace}/devnet/lean15/installers`;
        for (const [index, logicalMachineId] of logicalNodes.entries()) {
          updateAutopilotStep(
            'installers',
            'running',
            `Installing ${toLogicalNodeLabel(logicalMachineId)} (${index + 1}/${logicalNodes.length})`,
          );
          const installScript = `${basePath}/${logicalMachineId}/install_and_start.sh`;
          setLogicalNodeState(logicalMachineId, 'running', 'running installer');
          try {
            await runStrictCommand(`bash "${installScript}"`, resolvedWorkspace || null);
            setLogicalNodeState(logicalMachineId, 'success', 'installer complete');
            await sleep(AUTOPILOT_NODE_PAUSE_MS);
          } catch (installError) {
            setLogicalNodeState(logicalMachineId, 'failed', String(installError));
            throw installError;
          }
        }
      });

      await runStep('validation', 'Validate local node readiness and snapshot', async () => {
        const statusFailures = [];
        const basePath = `${resolvedWorkspace}/devnet/lean15/installers`;

        for (const [index, logicalMachineId] of logicalNodes.entries()) {
          updateAutopilotStep(
            'validation',
            'running',
            `Checking ${toLogicalNodeLabel(logicalMachineId)} (${index + 1}/${logicalNodes.length})`,
          );

          let validated = false;
          let localError = '';
          let remoteError = '';
          setLogicalNodeState(logicalMachineId, 'running', 'running status checks');

          for (let attempt = 1; attempt <= 3; attempt += 1) {
            updateAutopilotStep(
              'validation',
              'running',
              `Checking ${toLogicalNodeLabel(logicalMachineId)} attempt ${attempt}/3`,
            );

            try {
              await runStrictCommand(`bash "${basePath}/${logicalMachineId}/nodectl.sh" status`, resolvedWorkspace || null);
              validated = true;
              break;
            } catch (localStatusError) {
              localError = String(localStatusError);
            }

            try {
              const result = await invoke('monitor_node_control', {
                nodeSlotId: logicalMachineId,
                action: 'status',
              });
              if (result?.success) {
                validated = true;
                break;
              }
              remoteError = String(result?.stderr || result?.stdout || 'remote status action unsuccessful');
            } catch (remoteStatusError) {
              remoteError = String(remoteStatusError);
            }

            await new Promise((resolve) => {
              window.setTimeout(resolve, 2500);
            });
          }

          if (!validated) {
            setLogicalNodeState(logicalMachineId, 'failed', 'status validation failed');
            statusFailures.push(
              `${logicalMachineId}: local status failed (${localError || 'unknown'}), remote status failed (${remoteError || 'unknown'})`,
            );
            await sleep(AUTOPILOT_NODE_PAUSE_MS);
            continue;
          }

          try {
            const rpcResult = await invoke('monitor_node_control', {
              nodeSlotId: logicalMachineId,
              action: 'rpc:get_node_status',
            });
            if (!rpcResult?.success) {
              addTerminalLine(
                'info',
                `${logicalMachineId}: rpc:get_node_status not ready yet (${rpcResult?.stderr || 'pending'})`,
              );
            }
          } catch (rpcCheckError) {
            addTerminalLine('info', `${logicalMachineId}: rpc:get_node_status check pending (${String(rpcCheckError)})`);
          }

          setLogicalNodeState(logicalMachineId, 'success', 'validated');
          await sleep(AUTOPILOT_NODE_PAUSE_MS);
        }

        const snapshot = await invoke('get_monitor_snapshot');
        const snapshotNodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
        const snapshotErrors = logicalNodes
          .filter((machineId) =>
            !snapshotNodes.some((entry) => String(entry?.node?.node_slot_id || '').toLowerCase() === machineId.toLowerCase()),
          )
          .map((machineId) => `${machineId}: missing from snapshot`);

        statusFailures.push(...snapshotErrors);

        if (statusFailures.length > 0) {
          throw new Error(statusFailures.join(' | '));
        }

        addTerminalLine('success', `Validation passed for ${formatLogicalNodeList(logicalNodes)}`);
      });

      await runStep('complete', 'Mark setup complete', async () => {
        await invoke('monitor_mark_setup_complete', {
          physicalMachineId: selectedMachine,
        });
      });

      await refreshSecurityState();
      setStep(6);
      setAutopilotSummary(
        `Autonomous setup finished for ${selectedMachine}. Logical nodes: ${formatLogicalNodeList(logicalNodes)}.`,
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

  useEffect(() => {
    if (loading) return;
    if (!autoStartMachineId) return;
    if (autopilotBusy || nodeSetupBusy) return;

    const machineId = toCanonicalMachineId(autoStartMachineId);
    setAutoStartMachineId('');
    if (!machineId) return;
    setStep(5);
    addTerminalLine('info', `Auto-starting autonomous setup for ${machineId} from detected VPN identity.`);
    void runAutonomousSetup(machineId, 'vpn-auto-detect');
  }, [autoStartMachineId, autopilotBusy, loading, nodeSetupBusy]);

  const finalizeSetupAndEnter = async () => {
    setError('');
    try {
      await invoke('monitor_mark_setup_complete', {
        physicalMachineId: toCanonicalMachineId(selectedPhysicalMachine),
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
            <h2>Synergy Devnet Control Panel Setup Wizard</h2>
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
                disabled={autopilotBusy || nodeSetupBusy}
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
                <li>
                  Run
                  {' '}
                  <code>{`cd "${workspacePath}"`}</code>
                  {' '}
                  to enter the control panel workspace.
                </li>
                <li>Run <code>mkdir -p keys/ssh</code>.</li>
                <li>
                  Run
                  {' '}
                  <code>ssh-keygen -t ed25519 -a 64 -f keys/ssh/ops_ed25519 -C "devnet-ops" -N ""</code>
                  {' '}
                  to create keys without interactive prompts.
                </li>
                <li>Run <code>ls -lah keys/ssh</code> and verify private/public key files exist.</li>
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
                    placeholder={`${workspacePath}/keys/ssh/ops_ed25519`}
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
              <h3>Step 4: Bind SSH Profile To Machine</h3>
              <p>
                Machine options are
                {' '}
                <code>machine-01</code>
                {' '}
                through
                {' '}
                <code>machine-13</code>
                . Active deployment currently uses
                {' '}
                <code>machine-01</code>
                {' '}
                through
                {' '}
                <code>machine-08</code>
                .
              </p>
              <div className="wizard-form-grid">
                <label>
                  Machine ID
                  <select
                    value={bindingForm.node_slot_id}
                    onChange={(event) => {
                      const nextMachineId = event.target.value;
                      setBindingForm((prev) => ({
                        ...prev,
                        node_slot_id: nextMachineId,
                        host_override: PHYSICAL_MACHINE_VPN_IP[nextMachineId] || prev.host_override,
                      }));
                      if (PHYSICAL_MACHINE_VPN_IP[nextMachineId]) {
                        setSelectedPhysicalMachine(nextMachineId);
                      }
                    }}
                  >
                    <option value="" disabled>— Select this machine —</option>
                    {MACHINE_OPTIONS.map((machineId) => (
                      <option key={machineId} value={machineId}>
                        {machineId}
                        {activeMachineSet.has(machineId) ? ' (active)' : ''}
                      </option>
                    ))}
                  </select>
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
              <div className="wizard-action-row">
                <button className="monitor-btn monitor-btn-primary" onClick={bindMachineProfile} disabled={autopilotBusy || !bindingForm.node_slot_id}>
                  Bind Physical Machine Nodes And Continue
                </button>
                <button className="monitor-btn" onClick={() => setStep(5)} disabled={autopilotBusy}>
                  Skip Binding And Continue
                </button>
              </div>
            </div>
          ) : null}

          {step === 5 ? (
            <div className="wizard-section">
              <h3>Step 5: Local Node Setup</h3>
              <p>
                Deploy node slots for this physical machine now. WireGuard is already online, so this
                stage runs local installer scripts only.
              </p>
              <div className="wizard-form-grid">
                <label>
                  Physical Machine
                  <select
                    value={selectedPhysicalMachine}
                    onChange={(event) => {
                      const nextMachineId = event.target.value;
                      setSelectedPhysicalMachine(nextMachineId);
                      setBindingForm((prev) => ({
                        ...prev,
                        node_slot_id: nextMachineId,
                        host_override: PHYSICAL_MACHINE_VPN_IP[nextMachineId] || prev.host_override,
                      }));
                    }}
                  >
                    <option value="" disabled>— Select this machine —</option>
                    {ACTIVE_MACHINE_PLAN.map((entry) => (
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
                  Logical Node Slots
                  <input
                    value={formatLogicalNodeList(PHYSICAL_TO_LOGICAL_NODE_MAP[selectedPhysicalMachine] || [])}
                    readOnly
                  />
                </label>
              </div>
              {nodeSetupSummary ? (
                <p className="wizard-note">
                  <strong>{nodeSetupSummary}</strong>
                </p>
              ) : null}
              <div className="wizard-action-row">
                <button
                  className="monitor-btn monitor-btn-primary"
                  onClick={runLocalNodeSetup}
                  disabled={nodeSetupBusy || autopilotBusy || !selectedPhysicalMachine}
                >
                  {nodeSetupBusy ? 'Running Setup...' : 'Run Local Node Setup'}
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
          <h3>Active 13-Machine Devnet Topology</h3>
          <p>25 node slots across 13 physical machines. Primary validators are node-01, node-02, node-04, node-06, and node-08.</p>
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
                {ACTIVE_MACHINE_PLAN.map((entry) => (
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
