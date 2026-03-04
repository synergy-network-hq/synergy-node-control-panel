import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

const WG_BOOTSTRAP_SEQUENCE = ['wireguard_install', 'wireguard_connect', 'wireguard_status'];
const PROVISION_SEQUENCE = ['setup', 'start', 'status'];
const DEVNET_NODE_LAYOUT = [
  ['machine-01'],
  ['machine-02', 'machine-03'],
  ['machine-04', 'machine-05'],
  ['machine-06', 'machine-07'],
  ['machine-08', 'machine-09'],
  ['machine-10', 'machine-11'],
  ['machine-12', 'machine-13'],
  ['machine-14', 'machine-15'],
  ['machine-16', 'machine-17'],
  ['machine-18', 'machine-19'],
  ['machine-20', 'machine-21'],
  ['machine-22', 'machine-23'],
  ['machine-24', 'machine-25'],
];

function machineOrdinal(machineId) {
  const match = String(machineId || '').match(/(\d+)/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function sortMachineIds(machineIds) {
  return [...machineIds].sort((a, b) => {
    const aNum = machineOrdinal(a);
    const bNum = machineOrdinal(b);
    if (aNum !== bNum) return aNum - bNum;
    return String(a).localeCompare(String(b));
  });
}

function computeAssignments(inventory, deviceCount, deviceHosts) {
  if (!Number.isFinite(deviceCount) || deviceCount < 1) {
    return [];
  }

  const inventorySet = new Set(inventory.map((entry) => entry.machine_id));
  if (
    deviceCount === 13
    && DEVNET_NODE_LAYOUT.every((group) => group.every((machineId) => inventorySet.has(machineId)))
  ) {
    return DEVNET_NODE_LAYOUT.map((machineIds, index) => ({
      deviceIndex: index,
      deviceLabel: `device-${String(index + 1).padStart(2, '0')}`,
      host: String(deviceHosts[index] || '').trim(),
      machineIds: [...machineIds],
    }));
  }

  const machineIds = sortMachineIds(inventory.map((entry) => entry.machine_id));
  if (!machineIds.length) {
    return [];
  }

  const targetNodeCount = Math.min(machineIds.length, deviceCount * 2);
  const selectedIds = machineIds.slice(0, targetNodeCount);

  const assignments = [];
  for (let index = 0; index < deviceCount; index += 1) {
    const start = index * 2;
    const machineSlice = selectedIds.slice(start, start + 2);
    assignments.push({
      deviceIndex: index,
      deviceLabel: `device-${String(index + 1).padStart(2, '0')}`,
      host: String(deviceHosts[index] || '').trim(),
      machineIds: machineSlice,
    });
  }

  return assignments;
}

function truncateText(value, max = 420) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function isAffirmative(value) {
  return /^(y|yes|apply|go|continue|start|ok)$/i.test(String(value || '').trim());
}

function isNegative(value) {
  return /^(n|no|restart|reset)$/i.test(String(value || '').trim());
}

function formatSequence(sequence) {
  return sequence.join(' -> ');
}

function JarvisAgentSetup() {
  const initializedRef = useRef(false);
  const messagesEndRef = useRef(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState('booting');
  const [running, setRunning] = useState(false);

  const [workspacePath, setWorkspacePath] = useState('');
  const [inventory, setInventory] = useState([]);
  const [configuredMachineIds, setConfiguredMachineIds] = useState([]);

  const [machine01Host, setMachine01Host] = useState('');
  const [deviceCount, setDeviceCount] = useState(0);
  const [deviceHosts, setDeviceHosts] = useState([]);
  const [currentDeviceIndex, setCurrentDeviceIndex] = useState(0);

  const [defaults, setDefaults] = useState({
    sshUser: 'ops',
    sshPort: '22',
    sshKeyPath: '~/.ssh/id_ed25519',
    remoteRoot: '/opt/synergy',
    wgInterface: 'wg0',
    atlasBaseUrl: 'https://devnet-explorer.synergy-network.io',
  });

  const [haltedAction, setHaltedAction] = useState(null);
  const [snapshotSummary, setSnapshotSummary] = useState(null);

  const assignmentPlan = useMemo(
    () => computeAssignments(inventory, deviceCount, deviceHosts),
    [inventory, deviceCount, deviceHosts],
  );
  const inventoryByMachineId = useMemo(() => {
    const map = new Map();
    inventory.forEach((entry) => {
      map.set(entry.machine_id, entry);
    });
    return map;
  }, [inventory]);

  const addMessage = useCallback((sender, text, type = 'text') => {
    setMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        sender,
        text,
        type,
      },
    ]);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const resetWizardState = useCallback(() => {
    setMachine01Host('');
    setDeviceCount(0);
    setDeviceHosts([]);
    setCurrentDeviceIndex(0);
    setConfiguredMachineIds([]);
    setHaltedAction(null);
    setSnapshotSummary(null);
    setPhase('await_machine01_host');
    addMessage('jarvis', 'Restarting setup. Enter the reachable SSH host/IP for machine-01.');
  }, [addMessage]);

  const bootstrap = useCallback(async () => {
    setRunning(true);
    try {
      const workspace = await invoke('agent_monitor_initialize_workspace');
      const machines = await invoke('agent_get_inventory_machines');

      const orderedMachines = sortMachineIds(machines.map((entry) => entry.machine_id));
      setWorkspacePath(String(workspace || ''));
      setInventory(Array.isArray(machines) ? machines : []);

      addMessage('jarvis', "Hello. I'm Jarvis, your Devnet Setup Agent.");
      addMessage(
        'jarvis',
        `I will orchestrate closed-devnet setup for this fleet. Inventory loaded with ${orderedMachines.length} machine slots.`,
      );
      addMessage(
        'jarvis',
        `First target sequence on machine-01 is ${formatSequence(WG_BOOTSTRAP_SEQUENCE)}.`,
      );
      addMessage(
        'jarvis',
        'Step 1: enter the reachable SSH host/IP for machine-01 (public/LAN address, not 10.50.0.x).',
      );
      setPhase('await_machine01_host');
    } catch (error) {
      addMessage('jarvis', `Initialization failed: ${String(error)}`);
      setPhase('error');
    } finally {
      setRunning(false);
    }
  }, [addMessage]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    bootstrap();
  }, [bootstrap]);

  const runNodeAction = useCallback(
    async (machineId, action) => {
      try {
        const result = await invoke('monitor_node_control', { machineId, action });
        const success = Boolean(result?.success);
        const statusLabel = success ? 'OK' : 'FAILED';
        addMessage('jarvis', `${machineId}: ${action} -> ${statusLabel}`);

        const stdoutPreview = truncateText(result?.stdout);
        if (stdoutPreview) {
          addMessage('jarvis', stdoutPreview, 'code');
        }

        if (!success) {
          const stderrPreview = truncateText(result?.stderr || 'No stderr captured.');
          setHaltedAction({
            machineId,
            action,
            command: String(result?.command || ''),
            reason: stderrPreview,
          });
          addMessage(
            'jarvis',
            `Action halted on ${machineId}:${action}. Run the command manually, then click "I Ran It Manually" to continue.`,
          );
        }

        return success;
      } catch (error) {
        const reason = String(error);
        setHaltedAction({
          machineId,
          action,
          command: '',
          reason,
        });
        addMessage('jarvis', `${machineId}: ${action} could not execute in-app: ${reason}`);
        return false;
      }
    },
    [addMessage],
  );

  const runSequenceForMachine = useCallback(
    async (machineId, sequence, label) => {
      addMessage('jarvis', `Running ${label} on ${machineId}: ${formatSequence(sequence)}`);
      for (const action of sequence) {
        const ok = await runNodeAction(machineId, action);
        if (!ok) {
          return false;
        }
      }
      return true;
    },
    [addMessage, runNodeAction],
  );

  const applyPlan = useCallback(async () => {
    if (!assignmentPlan.length) {
      addMessage('jarvis', 'No assignment plan is available yet.');
      return;
    }

    const invalidHost = assignmentPlan.find((entry) => entry.machineIds.length > 0 && !entry.host);
    if (invalidHost) {
      addMessage('jarvis', `Missing host for ${invalidHost.deviceLabel}. Provide all device hosts first.`);
      return;
    }

    const machineMappings = assignmentPlan.flatMap((entry) =>
      entry.machineIds.map((machineId) => ({
        machine_id: machineId,
        host: entry.host,
        ssh_user: defaults.sshUser,
        ssh_port: Number(defaults.sshPort || 22),
        ssh_key_path: defaults.sshKeyPath,
        remote_dir: `${defaults.remoteRoot}/${machineId}`,
        wg_interface: defaults.wgInterface,
      })),
    );

    if (!machineMappings.length) {
      addMessage('jarvis', 'No machine mappings were generated from the current plan.');
      return;
    }

    setRunning(true);
    setHaltedAction(null);

    try {
      addMessage('jarvis', 'Applying hosts.env connection mappings...');
      const hostsPath = await invoke('agent_prepare_hosts_env', {
        input: {
          global_ssh_user: defaults.sshUser,
          global_ssh_port: Number(defaults.sshPort || 22),
          global_ssh_key_path: defaults.sshKeyPath,
          atlas_base_url: defaults.atlasBaseUrl,
          machines: machineMappings,
        },
      });
      addMessage('jarvis', `Updated hosts config: ${String(hostsPath)}`);

      addMessage('jarvis', 'Generating WireGuard mesh configs (keys + peer configs)...');
      const meshResult = await invoke('agent_generate_wireguard_mesh');
      if (!meshResult?.success) {
        setHaltedAction({
          machineId: 'local-control',
          action: 'generate_wireguard_mesh',
          command: String(meshResult?.command || ''),
          reason: truncateText(meshResult?.stderr || meshResult?.stdout || 'Mesh generation failed.'),
        });
        addMessage(
          'jarvis',
          'WireGuard mesh generation failed locally. Install local WireGuard tools if missing, run the command shown, then continue.',
        );
        setConfiguredMachineIds(machineMappings.map((entry) => entry.machine_id));
        setPhase('ready_actions');
        return;
      }

      addMessage('jarvis', 'WireGuard mesh artifacts generated successfully.');

      const configuredIds = sortMachineIds(machineMappings.map((entry) => entry.machine_id));
      setConfiguredMachineIds(configuredIds);

      if (configuredIds.includes('machine-01')) {
        const ok = await runSequenceForMachine('machine-01', WG_BOOTSTRAP_SEQUENCE, 'WireGuard bootstrap');
        if (!ok) {
          setPhase('ready_actions');
          return;
        }
        addMessage('jarvis', 'machine-01 WireGuard bootstrap completed.');
      }

      addMessage(
        'jarvis',
        'Base setup complete. Use the action buttons to run WireGuard/provisioning across all assigned machines.',
      );
      setPhase('ready_actions');
    } catch (error) {
      addMessage('jarvis', `Apply step failed: ${String(error)}`);
      setPhase('ready_actions');
    } finally {
      setRunning(false);
    }
  }, [addMessage, assignmentPlan, defaults, runSequenceForMachine]);

  const runWireguardAll = useCallback(async () => {
    const targets = configuredMachineIds.length
      ? configuredMachineIds
      : sortMachineIds(assignmentPlan.flatMap((entry) => entry.machineIds));

    if (!targets.length) {
      addMessage('jarvis', 'No configured machine targets available. Apply setup plan first.');
      return;
    }

    setRunning(true);
    setHaltedAction(null);
    try {
      for (const machineId of targets) {
        const ok = await runSequenceForMachine(machineId, WG_BOOTSTRAP_SEQUENCE, 'WireGuard setup');
        if (!ok) {
          addMessage('jarvis', 'WireGuard fleet run paused on failure. Resolve and retry.');
          return;
        }
      }
      addMessage('jarvis', 'WireGuard sequence completed across all assigned machines.');
    } finally {
      setRunning(false);
    }
  }, [addMessage, assignmentPlan, configuredMachineIds, runSequenceForMachine]);

  const runProvisionAll = useCallback(async () => {
    const targets = configuredMachineIds.length
      ? configuredMachineIds
      : sortMachineIds(assignmentPlan.flatMap((entry) => entry.machineIds));

    if (!targets.length) {
      addMessage('jarvis', 'No configured machine targets available. Apply setup plan first.');
      return;
    }

    setRunning(true);
    setHaltedAction(null);
    try {
      for (const machineId of targets) {
        const ok = await runSequenceForMachine(machineId, PROVISION_SEQUENCE, 'Node provision/start');
        if (!ok) {
          addMessage('jarvis', 'Provisioning paused on failure. Resolve and retry.');
          return;
        }
      }
      addMessage('jarvis', 'Provision + start sequence completed across assigned machines.');
    } finally {
      setRunning(false);
    }
  }, [addMessage, assignmentPlan, configuredMachineIds, runSequenceForMachine]);

  const refreshFleetStatus = useCallback(async () => {
    setRunning(true);
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
      addMessage(
        'jarvis',
        `Fleet snapshot: online ${summary.online}/${summary.total}, offline ${summary.offline}, syncing ${summary.syncing}, highest block ${summary.highestBlock}.`,
      );
    } catch (error) {
      addMessage('jarvis', `Snapshot refresh failed: ${String(error)}`);
    } finally {
      setRunning(false);
    }
  }, [addMessage]);

  const handleSend = useCallback(
    async (event) => {
      event.preventDefault();
      const value = input.trim();
      if (!value || running) return;

      addMessage('user', value);
      setInput('');

      if (phase === 'await_machine01_host') {
        setMachine01Host(value);
        setDeviceHosts([value]);
        setCurrentDeviceIndex(0);
        setPhase('await_device_count');
        addMessage('jarvis', 'Now enter the number of physical devices to configure (each gets up to 2 node slots).');
        return;
      }

      if (phase === 'await_device_count') {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          addMessage('jarvis', 'Enter a valid device count (integer >= 1).');
          return;
        }

        setDeviceCount(parsed);
        const nextHosts = Array.from({ length: parsed }, () => '');
        nextHosts[0] = machine01Host;
        setDeviceHosts(nextHosts);

        if (parsed === 1) {
          setPhase('review');
          addMessage('jarvis', 'Single-device plan prepared. Reply "yes" to apply setup, or "no" to restart.');
        } else {
          setCurrentDeviceIndex(1);
          setPhase('await_device_hosts');
          if (parsed === 13) {
            addMessage(
              'jarvis',
              '13-device topology detected. I will use fixed placement: machine-01 only on device-01, then node pairings across devices 02-13.',
            );
          }
          addMessage('jarvis', `Enter reachable SSH host/IP for device-02.`);
        }
        return;
      }

      if (phase === 'await_device_hosts') {
        const next = [...deviceHosts];
        next[currentDeviceIndex] = value;
        setDeviceHosts(next);

        const nextIndex = currentDeviceIndex + 1;
        if (nextIndex >= deviceCount) {
          setPhase('review');
          addMessage('jarvis', 'All device hosts collected. Reply "yes" to apply setup, or "no" to restart.');
        } else {
          setCurrentDeviceIndex(nextIndex);
          addMessage('jarvis', `Enter reachable SSH host/IP for device-${String(nextIndex + 1).padStart(2, '0')}.`);
        }
        return;
      }

      if (phase === 'review') {
        if (isAffirmative(value)) {
          await applyPlan();
          return;
        }
        if (isNegative(value)) {
          resetWizardState();
          return;
        }
        addMessage('jarvis', 'Reply "yes" to apply setup now, or "no" to restart.');
        return;
      }

      if (phase === 'ready_actions') {
        if (isNegative(value)) {
          resetWizardState();
          return;
        }
        addMessage('jarvis', 'Use the action buttons below for fleet operations, or type "restart" to rerun onboarding.');
      }
    },
    [
      addMessage,
      applyPlan,
      currentDeviceIndex,
      deviceCount,
      deviceHosts,
      input,
      machine01Host,
      phase,
      resetWizardState,
      running,
    ],
  );

  const machinePlanLines = assignmentPlan
    .filter((entry) => entry.machineIds.length > 0)
    .map((entry) => {
      const roleSummary = entry.machineIds
        .map((machineId) => {
          const machine = inventoryByMachineId.get(machineId);
          if (!machine) return machineId;
          return `${machineId} (${machine.role}/${machine.node_type})`;
        })
        .join(', ');
      return `${entry.deviceLabel} [${entry.host || 'missing-host'}] => ${roleSummary}`;
    });

  return (
    <section className="jarvis-shell">
      <div className="jarvis-toolbar">
        <div>
          <h2>Jarvis Devnet Setup Agent</h2>
          <p className="monitor-path">
            Workspace:
            {' '}
            <code>{workspacePath || 'Not initialized'}</code>
          </p>
          <p className="monitor-path">
            Phase:
            {' '}
            <strong>{phase}</strong>
          </p>
        </div>
        <div className="jarvis-toolbar-actions">
          <button className="monitor-btn" onClick={refreshFleetStatus} disabled={running}>
            Refresh Fleet Status
          </button>
          <button className="monitor-btn" onClick={resetWizardState} disabled={running}>
            Restart Wizard
          </button>
        </div>
      </div>

      <div className="jarvis-grid">
        <article className="monitor-panel jarvis-config-panel">
          <h3>Operator Defaults</h3>
          <p className="monitor-path">Set once, then Jarvis applies these to all assigned machine slots.</p>
          <div className="monitor-form-grid">
            <input
              value={defaults.sshUser}
              onChange={(event) => setDefaults((prev) => ({ ...prev, sshUser: event.target.value }))}
              placeholder="SSH user"
            />
            <input
              value={defaults.sshPort}
              onChange={(event) => setDefaults((prev) => ({ ...prev, sshPort: event.target.value }))}
              placeholder="SSH port"
            />
            <input
              value={defaults.sshKeyPath}
              onChange={(event) => setDefaults((prev) => ({ ...prev, sshKeyPath: event.target.value }))}
              placeholder="SSH key path"
            />
            <input
              value={defaults.remoteRoot}
              onChange={(event) => setDefaults((prev) => ({ ...prev, remoteRoot: event.target.value }))}
              placeholder="Remote node root"
            />
            <input
              value={defaults.wgInterface}
              onChange={(event) => setDefaults((prev) => ({ ...prev, wgInterface: event.target.value }))}
              placeholder="WireGuard interface"
            />
            <input
              value={defaults.atlasBaseUrl}
              onChange={(event) => setDefaults((prev) => ({ ...prev, atlasBaseUrl: event.target.value }))}
              placeholder="Atlas base URL"
            />
          </div>

          <h3>Current Assignment Plan</h3>
          <p className="monitor-path">Target: 2 nodes per physical device where inventory capacity allows.</p>
          <div className="jarvis-plan-list">
            {machinePlanLines.length ? (
              machinePlanLines.map((line) => <p key={line}>{line}</p>)
            ) : (
              <p>No plan yet. Follow Jarvis chat prompts.</p>
            )}
          </div>

          <div className="jarvis-action-row">
            <button className="monitor-btn monitor-btn-primary" onClick={applyPlan} disabled={running || phase === 'booting'}>
              Apply Plan + Bootstrap machine-01
            </button>
            <button className="monitor-btn" onClick={runWireguardAll} disabled={running || !assignmentPlan.length}>
              WireGuard All Assigned
            </button>
            <button className="monitor-btn" onClick={runProvisionAll} disabled={running || !assignmentPlan.length}>
              Provision + Start All Assigned
            </button>
          </div>

          {snapshotSummary ? (
            <div className="monitor-error-box jarvis-snapshot-box">
              <strong>Fleet Status:</strong>
              {' '}
              {`online ${snapshotSummary.online}/${snapshotSummary.total}, offline ${snapshotSummary.offline}, syncing ${snapshotSummary.syncing}, highest block ${snapshotSummary.highestBlock}`}
            </div>
          ) : null}

          {haltedAction ? (
            <div className="monitor-error-box jarvis-halt-box">
              <strong>
                Manual step required:
                {' '}
                {haltedAction.machineId}
                {' / '}
                {haltedAction.action}
              </strong>
              <p>{haltedAction.reason}</p>
              {haltedAction.command ? <pre>{haltedAction.command}</pre> : null}
              <div className="jarvis-action-row">
                <button
                  className="monitor-btn"
                  onClick={async () => {
                    setRunning(true);
                    let ok = false;
                    if (
                      haltedAction.machineId === 'local-control'
                      && haltedAction.action === 'generate_wireguard_mesh'
                    ) {
                      try {
                        const meshResult = await invoke('agent_generate_wireguard_mesh');
                        ok = Boolean(meshResult?.success);
                        if (!ok) {
                          addMessage(
                            'jarvis',
                            `Local mesh retry failed: ${truncateText(meshResult?.stderr || meshResult?.stdout)}`,
                          );
                        }
                      } catch (error) {
                        addMessage('jarvis', `Local mesh retry failed: ${String(error)}`);
                      }
                    } else {
                      ok = await runNodeAction(haltedAction.machineId, haltedAction.action);
                    }
                    if (ok) {
                      setHaltedAction(null);
                      addMessage('jarvis', 'Retry succeeded.');
                    }
                    setRunning(false);
                  }}
                  disabled={running}
                >
                  Retry In App
                </button>
                <button
                  className="monitor-btn"
                  onClick={() => {
                    addMessage('jarvis', 'Manual step acknowledged. Continuing from current state.');
                    setHaltedAction(null);
                  }}
                  disabled={running}
                >
                  I Ran It Manually
                </button>
              </div>
            </div>
          ) : null}
        </article>

        <article className="monitor-panel jarvis-chat-panel">
          <h3>Jarvis Chat</h3>
          <div className="jarvis-chat-log">
            {messages.map((message) => (
              <div key={message.id} className={`jarvis-chat-message jarvis-${message.sender}`}>
                <span className="jarvis-chat-author">{message.sender === 'user' ? 'You' : 'Jarvis'}</span>
                {message.type === 'code' ? <pre>{message.text}</pre> : <p>{message.text}</p>}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <form className="jarvis-chat-form" onSubmit={handleSend}>
            <input
              type="text"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Type response for Jarvis..."
              disabled={running || phase === 'booting' || phase === 'error'}
            />
            <button type="submit" className="monitor-btn monitor-btn-primary" disabled={running || !input.trim()}>
              Send
            </button>
          </form>
        </article>
      </div>
    </section>
  );
}

export default JarvisAgentSetup;
