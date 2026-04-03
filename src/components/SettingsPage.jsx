import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getVersion, invoke, openExternal, openPath } from '../lib/desktopClient';
import { useDeveloperMode } from '../lib/developerMode';
import {
  applyTestnetBetaPortSettings,
  formatPortSettingsForForm,
  formatPortSettingsSummary,
  getTestnetBetaDefaultPortSettings,
  getTestnetBetaPortFields,
  readStoredTestnetBetaPortSettings,
  readTestnetBetaNodePortSettings,
  refreshTestnetBetaBootstrapConfig,
  resetStoredTestnetBetaPortSettings,
  saveStoredTestnetBetaPortSettings,
  validateTestnetBetaPortSettingsForm,
} from '../lib/testnetBetaBootstrap';
import { SNRGButton } from '../styles/SNRGButton';

const TERMINAL_GREETING = 'Operator console ready. Use a guided action or run your own command below.';

function formatPath(path) {
  return String(path || '').trim() || 'Not available';
}

function formatEndpointStatus(items) {
  const total = Array.isArray(items) ? items.length : 0;
  const reachable = Array.isArray(items) ? items.filter((item) => item?.reachable).length : 0;
  return `${reachable}/${total}`;
}

function formatWholeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 'Not available';
  }
  return number.toLocaleString();
}

function formatClock() {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function normalizeOutputLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function createTerminalLine(kind, text) {
  return {
    id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    text,
    at: formatClock(),
  };
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\"'\"'`)}'`;
}

function detectPlatformKind(operatingSystem) {
  const text = String(operatingSystem || '').toLowerCase();
  if (text.includes('windows')) return 'windows';
  if (text.includes('linux')) return 'linux';
  return 'unix';
}

function buildProcessAuditCommand() {
  return [
    'matches="$(ps -axo pid=,etime=,command= | grep -E \'synergy-testbeta|control-service|Synergy Node Control Panel\' | grep -v grep || true)"',
    'echo "Synergy services currently running on this computer:"',
    'if [ -z "$matches" ]; then',
    '  echo "- No Synergy app or node services are running right now."',
    'else',
    '  echo "$matches" | while read -r pid etime command; do',
    '    [ -z "$pid" ] && continue',
    '    printf -- "- PID %s | Uptime %s | %s\\n" "$pid" "$etime" "$command"',
    '  done',
    'fi',
  ].join('\n');
}

function buildWorkspaceAuditCommand(storageRoot) {
  const root = storageRoot || '$HOME/.synergy/testnet-beta';
  return [
    `ROOT=${shellQuote(root)}`,
    'echo "Inspecting local Testnet-Beta workspace folders:"',
    'if [ ! -d "$ROOT/nodes" ]; then',
    '  echo "- Workspace root not found: $ROOT/nodes"',
    '  exit 0',
    'fi',
    'found=0',
    'for dir in "$ROOT"/nodes/*; do',
    '  [ -d "$dir" ] || continue',
    '  found=1',
    '  label="$(basename "$dir")"',
    '  if [ -f "$dir/config/node.toml" ]; then',
    '    echo "- $label: config present and ready for reuse."',
    '  else',
    '    echo "- $label: config missing. This folder looks incomplete or stale."',
    '  fi',
    'done',
    'if [ "$found" -eq 0 ]; then',
    '  echo "- No node workspaces are present yet."',
    'fi',
  ].join('\n');
}

function buildPortListenerCommand() {
  return [
    'listeners="$(lsof -nP -iTCP:5620-5699 -sTCP:LISTEN 2>/dev/null || true)"',
    'rpcs="$(lsof -nP -iTCP:5640-5699 -sTCP:LISTEN 2>/dev/null || true)"',
    'echo "Local Synergy network listeners:"',
    'if [ -z "$listeners" ] && [ -z "$rpcs" ]; then',
    '  echo "- No Synergy listener ports are open right now."',
    '  exit 0',
    'fi',
    'if [ -n "$listeners" ]; then',
    '  echo "- P2P listeners"',
    '  echo "$listeners"',
    'fi',
    'if [ -n "$rpcs" ]; then',
    '  echo "- RPC listeners"',
    '  echo "$rpcs"',
    'fi',
  ].join('\n');
}

function buildLocalRpcCheckCommand(nodes, nodePortProfiles) {
  const rows = (Array.isArray(nodes) ? nodes : []).map((node) => {
    const port = nodePortProfiles?.[node.id]?.portSettings?.rpcPort
      ?? (5640 + Number(node?.port_slot || 0));
    const label = node.display_label || node.role_display_name || node.id;
    return `${label}|${port}`;
  });

  return [
    'echo "Checking local JSON-RPC endpoints for node workspaces on this computer:"',
    'while IFS=\'|\' read -r label port; do',
    '  [ -z "$label" ] && continue',
    '  payload=\'{"jsonrpc":"2.0","method":"synergy_blockNumber","params":[],"id":1}\'',
    '  result="$(curl -s --max-time 3 -X POST "http://127.0.0.1:$port" -H "Content-Type: application/json" -d "$payload" 2>/dev/null || true)"',
    '  if [ -n "$result" ]; then',
    '    echo "- $label: RPC on port $port responded."',
    '  else',
    '    echo "- $label: RPC on port $port did not answer."',
    '  fi',
    "done <<'EOF'",
    rows.join('\n'),
    'EOF',
  ].join('\n');
}

function buildBootstrapCheckCommand(networkProfile, publicRpcEndpoint) {
  const endpoints = [
    ...(Array.isArray(networkProfile?.bootnodes) ? networkProfile.bootnodes : []).map((entry) => ({
      label: `${entry.host}:${entry.port}`,
      host: entry.host,
      port: entry.port,
      kind: 'bootnode',
    })),
    ...(Array.isArray(networkProfile?.seed_servers) ? networkProfile.seed_servers : []).map((entry) => ({
      label: `${entry.host}:${entry.port}`,
      host: entry.host,
      port: entry.port,
      kind: 'seed',
    })),
  ];

  const payload = JSON.stringify({
    publicRpcEndpoint: publicRpcEndpoint || 'https://testbeta-core-rpc.synergy-network.io',
    endpoints,
  }).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  return [
    'python3 - <<\'PY\'',
    'import json',
    'import socket',
    'import urllib.request',
    'import urllib.error',
    '',
    `payload = json.loads('${payload}')`,
    'print("Checking public bootstrap and discovery endpoints:")',
    'for entry in payload.get("endpoints", []):',
    '    host = entry.get("host", "")',
    '    port = int(entry.get("port", 0) or 0)',
    '    label = entry.get("label", host)',
    '    kind = entry.get("kind", "endpoint")',
    '    try:',
    '        with socket.create_connection((host, port), timeout=3):',
    '            print(f"- {label} ({kind}) is reachable.")',
    '    except Exception as error:',
    '        print(f"- {label} ({kind}) is NOT reachable: {error}")',
    'rpc_url = payload.get("publicRpcEndpoint")',
    'if rpc_url:',
    '    try:',
    '        request = urllib.request.Request(rpc_url, data=json.dumps({"jsonrpc":"2.0","method":"synergy_blockNumber","params":[],"id":1}).encode("utf-8"), headers={"Content-Type":"application/json"})',
    '        with urllib.request.urlopen(request, timeout=4) as response:',
    '            body = response.read().decode("utf-8", "replace")',
    '        print(f"- Public RPC answered successfully: {rpc_url}")',
    '        print(body[:220])',
    '    except Exception as error:',
    '        print(f"- Public RPC did not answer cleanly: {rpc_url} | {error}")',
    'PY',
  ].join('\n');
}

function buildStaleProcessInspectionCommand() {
  return [
    'echo "Looking for stale Synergy node processes:"',
    'matches="$(ps -axo pid=,command= | grep \'synergy-testbeta\' | grep \' start --config \' | grep -v grep || true)"',
    'if [ -z "$matches" ]; then',
    '  echo "- No Synergy node runtimes are running."',
    '  exit 0',
    'fi',
    'found=0',
    'echo "$matches" | while read -r pid command; do',
    '  [ -z "$pid" ] && continue',
    '  config_path="${command#* --config }"',
    '  config_path="${config_path%% *}"',
    '  reason=""',
    '  echo "$command" | grep -q \'/.Trash/\' && reason="running from Trash"',
    '  if [ -z "$reason" ] && [ ! -f "$config_path" ]; then',
    '    reason="config path missing"',
    '  fi',
    '  if [ -n "$reason" ]; then',
    '    found=1',
    '    echo "- PID $pid is stale: $reason | $config_path"',
    '  fi',
    'done',
    'echo "If nothing was listed above, no stale processes were detected."',
  ].join('\n');
}

function buildStaleProcessCleanupCommand() {
  return [
    'echo "Stopping stale Synergy node processes:"',
    'matches="$(ps -axo pid=,command= | grep \'synergy-testbeta\' | grep \' start --config \' | grep -v grep || true)"',
    'if [ -z "$matches" ]; then',
    '  echo "- No Synergy node runtimes are running."',
    '  exit 0',
    'fi',
    'stale_pids=""',
    'echo "$matches" | while read -r pid command; do',
    '  [ -z "$pid" ] && continue',
    '  config_path="${command#* --config }"',
    '  config_path="${config_path%% *}"',
    '  if echo "$command" | grep -q \'/.Trash/\'; then',
    '    echo "$pid" >> /tmp/synergy-stale-pids.$$',
    '    echo "- Marked PID $pid for stop (running from Trash)."',
    '  elif [ ! -f "$config_path" ]; then',
    '    echo "$pid" >> /tmp/synergy-stale-pids.$$',
    '    echo "- Marked PID $pid for stop (missing config path)."',
    '  fi',
    'done',
    'if [ ! -f /tmp/synergy-stale-pids.$$ ]; then',
    '  echo "- No stale processes were found."',
    '  exit 0',
    'fi',
    'stale_pids="$(tr \'\\n\' \' \' < /tmp/synergy-stale-pids.$$)"',
    'rm -f /tmp/synergy-stale-pids.$$',
    'if [ -z "$stale_pids" ]; then',
    '  echo "- No stale processes were found."',
    '  exit 0',
    'fi',
    'kill $stale_pids',
    'echo "- Requested shutdown for stale process IDs: $stale_pids"',
  ].join('\n');
}

function buildKillAllNodesCommand() {
  return [
    'echo "Stopping all Synergy node processes:"',
    'pids="$(pgrep -f synergy-testbeta || true)"',
    'if [ -z "$pids" ]; then',
    '  echo "- No Synergy node processes are running."',
    '  exit 0',
    'fi',
    'echo "Sending shutdown signal to PIDs: $pids"',
    'kill $pids',
    'sleep 1',
    'remaining="$(pgrep -f synergy-testbeta || true)"',
    'if [ -z "$remaining" ]; then',
    '  echo "- All node processes stopped."',
    'else',
    '  echo "- Sending SIGKILL to remaining PIDs: $remaining"',
    '  kill -9 $remaining',
    'fi',
  ].join('\n');
}

function buildTailLogsCommand(storageRoot) {
  const root = storageRoot || '$HOME/.synergy/testnet-beta';
  return [
    `ROOT=${shellQuote(root)}`,
    'echo "Recent log output from node workspaces:"',
    'found=0',
    'for logfile in "$ROOT"/nodes/*/logs/synergy-testbeta.log; do',
    '  [ -f "$logfile" ] || continue',
    '  found=1',
    '  label="$(basename "$(dirname "$(dirname "$logfile")")")"',
    '  echo "--- $label ---"',
    '  tail -n 40 "$logfile"',
    'done',
    '[ "$found" -eq 0 ] && echo "- No node log files found."',
  ].join('\n');
}

function buildDiskUsageCommand(storageRoot) {
  const root = storageRoot || '$HOME/.synergy/testnet-beta';
  return [
    `ROOT=${shellQuote(root)}`,
    'echo "Workspace disk usage:"',
    'if [ ! -d "$ROOT" ]; then',
    '  echo "- Workspace not found at $ROOT"',
    '  exit 0',
    'fi',
    'du -sh "$ROOT"/* 2>/dev/null | sort -rh | head -20',
    'echo ""',
    'echo "Total:"',
    'du -sh "$ROOT" 2>/dev/null',
  ].join('\n');
}

function buildFlushDnsCommand() {
  return [
    'echo "Flushing DNS resolver cache:"',
    'if command -v dscacheutil >/dev/null 2>&1; then',
    '  dscacheutil -flushcache',
    '  killall -HUP mDNSResponder 2>/dev/null || true',
    '  echo "- DNS cache flushed (macOS)."',
    'elif systemctl is-active --quiet systemd-resolved 2>/dev/null; then',
    '  resolvectl flush-caches 2>/dev/null || sudo systemctl flush-dns systemd-resolved 2>/dev/null || true',
    '  echo "- DNS cache flushed (systemd-resolved)."',
    'else',
    '  echo "- No supported DNS resolver found on this system."',
    'fi',
  ].join('\n');
}

function buildClearLogsCommand(storageRoot) {
  const root = storageRoot || '$HOME/.synergy/testnet-beta';
  return [
    `ROOT=${shellQuote(root)}`,
    'echo "Clearing node log files:"',
    'found=0',
    'for logfile in "$ROOT"/nodes/*/logs/*.log; do',
    '  [ -f "$logfile" ] || continue',
    '  found=1',
    '  label="$(basename "$(dirname "$(dirname "$logfile")")")/$(basename "$logfile")"',
    '  : > "$logfile"',
    '  echo "- Cleared: $label"',
    'done',
    '[ "$found" -eq 0 ] && echo "- No log files found to clear."',
  ].join('\n');
}

function buildCommandGroups({
  platformKind,
  networkProfile,
  publicRpcEndpoint,
  nodes,
  nodePortProfiles,
  storageRoot,
}) {
  if (platformKind === 'windows') {
    return [
      {
        id: 'services',
        title: 'Operator Console',
        accent: 'violet',
        actions: [],
      },
    ];
  }

  return [
    {
      id: 'services',
      title: 'Services',
      accent: 'violet',
      actions: [
        {
          id: 'process-audit',
          label: 'Check Running Services',
          variant: 'purple',
          description: 'Lists control panel and node runtimes with uptime.',
          command: buildProcessAuditCommand(),
        },
        {
          id: 'listener-audit',
          label: 'Show Port Listeners',
          variant: 'purple',
          description: 'Shows which P2P and RPC ports are open locally.',
          command: buildPortListenerCommand(),
        },
        {
          id: 'workspace-audit',
          label: 'Inspect Workspaces',
          variant: 'purple',
          description: 'Checks which local node folders are complete versus stale.',
          command: buildWorkspaceAuditCommand(storageRoot),
        },
        {
          id: 'disk-usage',
          label: 'Show Disk Usage',
          variant: 'purple',
          description: 'Reports how much disk space each workspace folder is consuming.',
          command: buildDiskUsageCommand(storageRoot),
        },
      ],
    },
    {
      id: 'connectivity',
      title: 'Connectivity',
      accent: 'cyan',
      actions: [
        {
          id: 'local-rpc',
          label: 'Test Local RPC',
          variant: 'cyan',
          description: 'Checks whether each local node RPC endpoint is responding.',
          command: buildLocalRpcCheckCommand(nodes, nodePortProfiles),
        },
        {
          id: 'bootstrap-test',
          label: 'Test Bootstrap Network',
          variant: 'cyan',
          description: 'Checks bootnodes, seed servers, and the public RPC endpoint.',
          command: buildBootstrapCheckCommand(networkProfile, publicRpcEndpoint),
        },
        {
          id: 'flush-dns',
          label: 'Flush DNS Cache',
          variant: 'cyan',
          description: 'Clears the local DNS resolver cache to force fresh lookups.',
          command: buildFlushDnsCommand(),
        },
      ],
    },
    {
      id: 'processes',
      title: 'Processes',
      accent: 'amber',
      actions: [
        {
          id: 'find-stale',
          label: 'Find Zombie Processes',
          variant: 'yellow',
          description: 'Scans for node processes running from Trash or with missing configs.',
          command: buildStaleProcessInspectionCommand(),
        },
        {
          id: 'clear-stale',
          label: 'Kill Zombie Processes',
          variant: 'yellow',
          description: 'Stops only the zombie processes that are safe to remove.',
          command: buildStaleProcessCleanupCommand(),
          refreshAfterRun: true,
        },
        {
          id: 'kill-all',
          label: 'Kill All Nodes',
          variant: 'yellow',
          description: 'Force-stops ALL running Synergy node processes on this machine.',
          command: buildKillAllNodesCommand(),
          refreshAfterRun: true,
        },
      ],
    },
    {
      id: 'logs',
      title: 'Logs',
      accent: 'lime',
      actions: [
        {
          id: 'tail-logs',
          label: 'Tail Node Logs',
          variant: 'lime',
          description: 'Shows the last 40 lines from each active node log file.',
          command: buildTailLogsCommand(storageRoot),
        },
        {
          id: 'clear-logs',
          label: 'Clear Log Files',
          variant: 'lime',
          description: 'Empties all node log files without deleting them.',
          command: buildClearLogsCommand(storageRoot),
        },
      ],
    },
  ];
}

function DefinitionRow({ label, value, detail }) {
  return (
    <div className="settings-shell-definition-row">
      <span className="settings-shell-definition-label">{label}</span>
      <div className="settings-shell-definition-value">
        <strong>{value}</strong>
        {detail ? <small>{detail}</small> : null}
      </div>
    </div>
  );
}

function SettingsPage() {
  const [state, setState] = useState(null);
  const [liveStatus, setLiveStatus] = useState(null);
  const [version, setVersion] = useState('');
  const [developerModeEnabled, setDeveloperModeEnabled] = useDeveloperMode();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savedPortSettings, setSavedPortSettings] = useState(() => readStoredTestnetBetaPortSettings());
  const [portForm, setPortForm] = useState(() => formatPortSettingsForForm(readStoredTestnetBetaPortSettings()));
  const [portErrors, setPortErrors] = useState({});
  const [portMessage, setPortMessage] = useState('');
  const [portMessageTone, setPortMessageTone] = useState('good');
  const [portBusy, setPortBusy] = useState('');
  const [nodePortProfiles, setNodePortProfiles] = useState({});
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalLines, setTerminalLines] = useState([]);
  const [terminalCwd, setTerminalCwd] = useState('');
  const [activeTerminalAction, setActiveTerminalAction] = useState('');
  const [updateStatus, setUpdateStatus] = useState('');
  const [updateBusy, setUpdateBusy] = useState(false);
  const [bootstrapRefreshBusy, setBootstrapRefreshBusy] = useState(false);
  const [bootstrapRefreshStatus, setBootstrapRefreshStatus] = useState('');

  const terminalScrollRef = useRef(null);
  const portFields = useMemo(() => getTestnetBetaPortFields(), []);
  const defaultPortSettings = useMemo(() => getTestnetBetaDefaultPortSettings(), []);

  const loadNodePortProfiles = useCallback(async (nodesInput) => {
    const nodes = Array.isArray(nodesInput) ? nodesInput : [];
    if (nodes.length === 0) {
      return {};
    }

    const results = await Promise.all(
      nodes.map(async (node) => {
        try {
          const { nodeTomlPath, portSettings } = await readTestnetBetaNodePortSettings(node);
          return [
            node.id,
            {
              ok: true,
              nodeTomlPath,
              portSettings,
            },
          ];
        } catch (readError) {
          return [
            node.id,
            {
              ok: false,
              error: String(readError),
            },
          ];
        }
      }),
    );

    return Object.fromEntries(results);
  }, []);

  const loadPage = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
    }

    try {
      const [nextState, nextLiveStatus, nextVersion] = await Promise.all([
        invoke('testbeta_get_state'),
        invoke('testbeta_get_live_status'),
        getVersion(),
      ]);

      const nextNodePortProfiles = await loadNodePortProfiles(nextState?.nodes);

      setState(nextState);
      setLiveStatus(nextLiveStatus);
      setVersion(String(nextVersion || ''));
      setNodePortProfiles(nextNodePortProfiles);
      setError('');
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, [loadNodePortProfiles]);

  useEffect(() => {
    loadPage();
  }, [loadPage]);

  const storageRoot = useMemo(() => {
    const home = state?.device_profile?.home_directory;
    if (!home) {
      return '';
    }
    return `${home.replace(/[\\/]+$/, '')}/.synergy/testnet-beta`;
  }, [state?.device_profile?.home_directory]);

  useEffect(() => {
    if (!terminalCwd) {
      setTerminalCwd(storageRoot || state?.device_profile?.home_directory || '');
    }
  }, [state?.device_profile?.home_directory, storageRoot, terminalCwd]);

  useEffect(() => {
    if (loading || terminalLines.length > 0) {
      return;
    }
    setTerminalLines([createTerminalLine('info', TERMINAL_GREETING)]);
  }, [loading, terminalLines.length]);

  useEffect(() => {
    terminalScrollRef.current?.scrollTo({
      top: terminalScrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [terminalLines]);

  const savedPortSummary = useMemo(
    () => formatPortSettingsSummary(savedPortSettings),
    [savedPortSettings],
  );
  const defaultPortSummary = useMemo(
    () => formatPortSettingsSummary(defaultPortSettings),
    [defaultPortSettings],
  );
  const provisionedNodes = Array.isArray(state?.nodes) ? state.nodes : [];
  const platformKind = useMemo(
    () => detectPlatformKind(state?.device_profile?.operating_system),
    [state?.device_profile?.operating_system],
  );

  const setPortNotice = useCallback((tone, message) => {
    setPortMessageTone(tone);
    setPortMessage(message);
  }, []);

  const refreshPortProfiles = useCallback(async (nodesInput) => {
    const nextProfiles = await loadNodePortProfiles(nodesInput);
    setNodePortProfiles(nextProfiles);
  }, [loadNodePortProfiles]);

  const addTerminalLine = useCallback((kind, text) => {
    const lines = Array.isArray(text) ? text : [text];
    const nextLines = lines
      .map((line) => String(line || '').trimEnd())
      .filter(Boolean)
      .map((line) => createTerminalLine(kind, line));

    if (!nextLines.length) {
      return;
    }

    setTerminalLines((current) => [...current, ...nextLines]);
  }, []);

  const executeTerminalCommand = useCallback(async (command, cwdOverride = null) => {
    const effectiveCwd = cwdOverride || terminalCwd || storageRoot || state?.device_profile?.home_directory || null;
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
  }, [addTerminalLine, state?.device_profile?.home_directory, storageRoot, terminalCwd]);

  const runTerminalCommand = useCallback(async (rawCommand, options = {}) => {
    const command = String(rawCommand || '').trim();
    if (!command || terminalBusy) {
      return;
    }

    setTerminalBusy(true);
    setActiveTerminalAction(options.actionId || '');
    try {
      if (options.announceLabel) {
        addTerminalLine('info', options.announceLabel);
      }
      const result = await executeTerminalCommand(command);
      if (!result?.success && normalizeOutputLines(result?.stderr).length === 0) {
        addTerminalLine('error', `Command failed with exit code ${result?.exit_code ?? 'unknown'}`);
      } else if (result?.success && options.successMessage) {
        addTerminalLine('success', options.successMessage);
      }
      if (options.refreshAfterRun) {
        await loadPage(true);
      }
    } catch (commandError) {
      addTerminalLine('error', String(commandError));
    } finally {
      setTerminalBusy(false);
      setActiveTerminalAction('');
    }
  }, [addTerminalLine, executeTerminalCommand, loadPage, terminalBusy]);

  const submitTerminal = useCallback(async (event) => {
    event.preventDefault();
    const command = terminalInput.trim();
    if (!command) {
      return;
    }
    setTerminalInput('');
    await runTerminalCommand(command);
  }, [runTerminalCommand, terminalInput]);

  const handlePortFieldChange = useCallback((key, value) => {
    setPortForm((current) => ({
      ...current,
      [key]: value,
    }));
    setPortErrors((current) => {
      if (!current[key]) {
        return current;
      }

      const nextErrors = { ...current };
      delete nextErrors[key];
      return nextErrors;
    });
  }, []);

  const validatePortForm = useCallback(() => {
    const result = validateTestnetBetaPortSettingsForm(portForm);
    setPortErrors(result.errors);
    if (!result.ok) {
      setPortNotice('bad', 'Fix the port validation errors before saving or applying the profile.');
      return null;
    }
    return result.value;
  }, [portForm, setPortNotice]);

  const handleSavePortProfile = useCallback(() => {
    const nextPorts = validatePortForm();
    if (!nextPorts) {
      return;
    }

    const saved = saveStoredTestnetBetaPortSettings(nextPorts);
    setSavedPortSettings(saved);
    setPortForm(formatPortSettingsForForm(saved));
    setPortErrors({});
    setPortNotice(
      'good',
      `Saved base port profile: ${formatPortSettingsSummary(saved)}. Each node keeps a stable local port offset from this base during setup, start, and sync.`,
    );
  }, [setPortNotice, validatePortForm]);

  const handleResetPortProfile = useCallback(() => {
    const defaults = resetStoredTestnetBetaPortSettings();
    setSavedPortSettings(defaults);
    setPortForm(formatPortSettingsForForm(defaults));
    setPortErrors({});
    setPortNotice('warn', `Restored default Testnet-Beta ports: ${formatPortSettingsSummary(defaults)}.`);
  }, [setPortNotice]);

  const handleApplyPortProfileToExistingNodes = useCallback(async () => {
    if (provisionedNodes.length === 0) {
      setPortNotice('warn', 'There are no provisioned nodes on this computer yet.');
      return;
    }

    const nextPorts = validatePortForm();
    if (!nextPorts) {
      return;
    }

    setPortBusy('apply');
    try {
      const saved = saveStoredTestnetBetaPortSettings(nextPorts);
      setSavedPortSettings(saved);
      setPortForm(formatPortSettingsForForm(saved));

      const results = await Promise.all(
        provisionedNodes.map(async (node) => {
          try {
            const result = await applyTestnetBetaPortSettings(node, saved);
            return {
              nodeId: node.id,
              ok: true,
              portSettings: result.portSettings,
            };
          } catch (applyError) {
            return {
              nodeId: node.id,
              ok: false,
              error: String(applyError),
            };
          }
        }),
      );

      await refreshPortProfiles(provisionedNodes);

      const failed = results.filter((result) => !result.ok);
      if (failed.length > 0) {
        const failureSummary = failed
          .slice(0, 2)
          .map((result) => {
            const node = provisionedNodes.find((entry) => entry.id === result.nodeId);
            return `${node?.display_label || node?.label || result.nodeId}: ${result.error}`;
          })
          .join(' | ');

        setPortNotice(
          'warn',
          `Applied the saved base profile to ${results.length - failed.length}/${results.length} node workspace(s). Restart any running nodes, then fix the remaining failures: ${failureSummary}`,
        );
      } else {
        setPortNotice(
          'good',
          `Applied base profile ${formatPortSettingsSummary(saved)} to ${results.length} node workspace(s) with stable per-node offsets. Restart any running nodes so the new ports take effect.`,
        );
      }
    } catch (applyError) {
      setPortNotice('bad', `Failed to update existing node configs: ${String(applyError)}`);
    } finally {
      setPortBusy('');
    }
  }, [provisionedNodes, refreshPortProfiles, setPortNotice, validatePortForm]);

  const handleCheckForUpdate = useCallback(async () => {
    setUpdateBusy(true);
    setUpdateStatus('Checking...');
    try {
      const bridge = window.synergyDesktop;
      if (!bridge?.checkForUpdate) {
        setUpdateStatus('Auto-updater not available in this build.');
        return;
      }
      const result = await bridge.checkForUpdate();
      if (result?.updateInfo?.version) {
        setUpdateStatus(`Update available: v${result.updateInfo.version} — downloading automatically.`);
      } else {
        setUpdateStatus(`Up to date (v${version || 'current'}).`);
      }
    } catch (err) {
      setUpdateStatus(`Update check failed: ${String(err)}`);
    } finally {
      setUpdateBusy(false);
    }
  }, [version]);

  const handleRefreshAllBootstrap = useCallback(async () => {
    if (!provisionedNodes.length || !state?.network_profile) {
      setBootstrapRefreshStatus('No provisioned nodes or network profile available.');
      return;
    }
    setBootstrapRefreshBusy(true);
    setBootstrapRefreshStatus('Refreshing bootstrap configs...');
    try {
      const results = await Promise.allSettled(
        provisionedNodes.map((node) =>
          refreshTestnetBetaBootstrapConfig(node, state.network_profile),
        ),
      );
      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - succeeded;
      setBootstrapRefreshStatus(
        failed === 0
          ? `Bootstrap configs refreshed for ${succeeded} node(s).`
          : `Refreshed ${succeeded}/${results.length} nodes. ${failed} failed.`,
      );
    } catch (err) {
      setBootstrapRefreshStatus(`Bootstrap refresh failed: ${String(err)}`);
    } finally {
      setBootstrapRefreshBusy(false);
    }
  }, [provisionedNodes, state?.network_profile]);

  const summaryCards = useMemo(
    () => [
      {
        label: 'App Version',
        value: version || 'Not available',
        detail: 'Installed desktop build',
      },
      {
        label: 'Machine',
        value: state?.device_profile?.hostname || 'Unknown',
        detail: state?.device_profile?.operating_system || 'Local operator host',
      },
      {
        label: 'Provisioned Nodes',
        value: String(provisionedNodes.length),
        detail: 'Node workspaces on this computer',
      },
      {
        label: 'Developer Mode',
        value: developerModeEnabled ? 'Enabled' : 'Off',
        detail: developerModeEnabled
          ? 'Connectivity peer diagnostics are visible in the dashboard'
          : 'Operator-only diagnostics stay hidden until enabled',
      },
      {
        label: 'Bootnodes Online',
        value: formatEndpointStatus(liveStatus?.bootnodes),
        detail: 'Public bootstrap listeners responding',
      },
      {
        label: 'Seed Services',
        value: formatEndpointStatus(liveStatus?.seed_servers),
        detail: 'Discovery services responding',
      },
      {
        label: 'Public Chain Tip',
        value: formatWholeNumber(liveStatus?.public_chain_height),
        detail: 'Latest height reported by the public RPC',
      },
      {
        label: 'Peers',
        value: formatWholeNumber(liveStatus?.network_peer_count ?? liveStatus?.public_peer_count),
        detail: liveStatus?.network_peer_count != null
          ? 'Unique peer dial targets published by the seed registry'
          : 'Visible peers from the public RPC view',
      },
    ],
    [
      liveStatus?.bootnodes,
      developerModeEnabled,
      liveStatus?.network_peer_count,
      liveStatus?.public_chain_height,
      liveStatus?.public_peer_count,
      liveStatus?.seed_servers,
      provisionedNodes.length,
      state?.device_profile?.hostname,
      state?.device_profile?.operating_system,
      version,
    ],
  );

  const commandGroups = useMemo(
    () => buildCommandGroups({
      platformKind,
      networkProfile: state?.network_profile,
      publicRpcEndpoint: liveStatus?.public_rpc_endpoint,
      nodes: provisionedNodes,
      nodePortProfiles,
      storageRoot,
    }),
    [
      liveStatus?.public_rpc_endpoint,
      nodePortProfiles,
      platformKind,
      provisionedNodes,
      state?.network_profile,
      storageRoot,
    ],
  );

  if (loading) {
    return (
      <section className="nodecp-settings-page">
        <div className="loading-container">
          <div className="spinner"></div>
          <p>Loading settings...</p>
        </div>
      </section>
    );
  }

  return (
    <section className="nodecp-settings-page settings-shell-page">
      <div className="settings-shell-hero">
        <div className="settings-shell-hero-copy">
          <p className="nodecp-page-kicker">Settings</p>
          <h2 className="nodecp-page-title">Control Panel + Local Node Operations</h2>
        </div>
        <div className="settings-shell-hero-actions">
          <SNRGButton as={Link} to="/" variant="purple" size="md">
            Back to Dashboard
          </SNRGButton>
          <SNRGButton
            variant="blue"
            size="md"
            onClick={() => storageRoot && openPath(storageRoot)}
          >
            Open Workspace Folder
          </SNRGButton>
          <SNRGButton
            variant="cyan"
            size="md"
            onClick={() => openExternal('https://testbeta-explorer.synergy-network.io')}
          >
            Open Explorer
          </SNRGButton>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="settings-shell-summary-grid">
        {summaryCards.map((card) => (
          <article key={card.label} className="settings-shell-summary-card">
            <span className="settings-shell-summary-label">{card.label}</span>
            <strong className="settings-shell-summary-value">{card.value}</strong>
            <span className="settings-shell-summary-detail">{card.detail}</span>
          </article>
        ))}
      </div>

      <div className="settings-shell-main-grid">
        <div className="settings-shell-column">
          <section className="settings-shell-panel">
            <div className="settings-shell-panel-header">
              <div>
                <p className="settings-shell-panel-kicker">Application</p>
                <h3>Desktop control surface</h3>
              </div>
            </div>
            <div className="settings-shell-definition-grid">
              <DefinitionRow
                label="App"
                value="Synergy Node Control Panel"
                detail={version || 'Version unavailable'}
              />
              <DefinitionRow
                label="Environment"
                value={state?.display_name || 'Testnet-Beta'}
                detail={`Chain ID ${state?.network_profile?.chain_id || 338639}`}
              />
              <DefinitionRow
                label="Machine"
                value={state?.device_profile?.hostname || 'Unknown'}
                detail={state?.device_profile?.operating_system || 'Operator machine'}
              />
              <DefinitionRow
                label="Workspace Root"
                value={formatPath(storageRoot)}
              />
            </div>
            <div className="settings-shell-feature-card">
              <div className="settings-shell-feature-copy">
                <span className="settings-shell-feature-kicker">Developer Mode</span>
                <strong>{developerModeEnabled ? 'Operator diagnostics are visible' : 'Operator diagnostics are hidden'}</strong>
                <p>
                  Reveal hidden troubleshooting surfaces in the dashboard, including the selected node&apos;s
                  live peer list on the Connectivity tab.
                </p>
              </div>
              <label className="settings-shell-toggle" aria-label="Enable developer mode">
                <input
                  type="checkbox"
                  checked={developerModeEnabled}
                  onChange={(event) => setDeveloperModeEnabled(event.target.checked)}
                />
                <span className="settings-shell-toggle-track" aria-hidden="true">
                  <span className="settings-shell-toggle-thumb"></span>
                </span>
                <span className="settings-shell-toggle-text">{developerModeEnabled ? 'On' : 'Off'}</span>
              </label>
            </div>
            <div className="settings-shell-definition-actions">
              <SNRGButton
                variant="blue"
                size="sm"
                disabled={updateBusy}
                onClick={handleCheckForUpdate}
              >
                {updateBusy ? 'Checking...' : 'Check for Updates'}
              </SNRGButton>
              {updateStatus && (
                <span className="settings-shell-update-status">{updateStatus}</span>
              )}
            </div>
          </section>


          <section className="settings-shell-panel">
            <div className="settings-shell-panel-header">
              <div>
                <p className="settings-shell-panel-kicker">Workspace Inventory</p>
                <h3>Node workspaces on this machine</h3>
              </div>
              {provisionedNodes.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.3rem' }}>
                  <SNRGButton
                    variant="cyan"
                    size="sm"
                    disabled={bootstrapRefreshBusy}
                    onClick={handleRefreshAllBootstrap}
                  >
                    {bootstrapRefreshBusy ? 'Refreshing...' : 'Refresh All Bootstrap'}
                  </SNRGButton>
                  {bootstrapRefreshStatus && (
                    <span style={{ fontSize: '0.72rem', color: 'rgba(148,163,184,0.85)' }}>{bootstrapRefreshStatus}</span>
                  )}
                </div>
              )}
            </div>
            {provisionedNodes.length === 0 ? (
              <div className="settings-shell-empty">
                No node workspaces have been provisioned on this computer yet.
              </div>
            ) : (
              <div className="settings-shell-workspace-list">
                {provisionedNodes.map((node) => {
                  const profile = nodePortProfiles[node.id];
                  const nodeTomlPath = profile?.nodeTomlPath
                    || node?.config_paths?.find((entry) => String(entry).endsWith('/node.toml'))
                    || '';
                  const logsDir = node.workspace_directory ? `${node.workspace_directory}/logs` : '';

                  return (
                    <article key={node.id} className="settings-shell-workspace-card">
                      <div className="settings-shell-workspace-copy">
                        <div className="settings-shell-workspace-title-row">
                          <strong>{node.display_label || node.role_display_name || node.id}</strong>
                          <span className={`settings-shell-badge ${profile?.ok ? 'good' : 'warn'}`}>
                            {profile?.ok ? 'Config Ready' : 'Needs Review'}
                          </span>
                        </div>
                        <span className="settings-shell-workspace-ports">
                          {profile?.ok
                            ? formatPortSettingsSummary(profile.portSettings)
                            : (profile?.error || 'Reading node port config...')}
                        </span>
                        <code>{formatPath(nodeTomlPath || node.workspace_directory)}</code>
                      </div>
                      <div className="settings-shell-workspace-actions">
                        <SNRGButton
                          variant="blue"
                          size="sm"
                          disabled={!nodeTomlPath}
                          onClick={() => nodeTomlPath && openPath(nodeTomlPath)}
                        >
                          Config
                        </SNRGButton>
                        <SNRGButton
                          variant="blue"
                          size="sm"
                          disabled={!logsDir}
                          onClick={() => logsDir && openPath(logsDir)}
                        >
                          Logs
                        </SNRGButton>
                        <Link
                          to={`/node/${node.id}`}
                          className="settings-shell-node-link"
                        >
                          Details →
                        </Link>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <div className="settings-shell-column settings-shell-column-console">
          <section className="settings-shell-panel settings-shell-network-panel">
            <div className="settings-shell-panel-header">
              <div>
                <p className="settings-shell-panel-kicker">Network Snapshot</p>
                <h3>What this machine sees right now</h3>
              </div>
            </div>
            <div className="settings-shell-definition-grid">
              <DefinitionRow
                label="Public RPC"
                value={liveStatus?.public_rpc_endpoint || 'Not available'}
                detail={liveStatus?.public_rpc_online ? 'Responding' : 'Unavailable'}
              />
              <DefinitionRow
                label="Discovery"
                value={liveStatus?.discovery_status || 'Unknown'}
                detail={liveStatus?.discovery_detail || 'Waiting for a live check'}
              />
              <DefinitionRow
                label="Live Chain Height"
                value={formatWholeNumber(liveStatus?.public_chain_height)}
                detail="Latest height from the public RPC endpoint"
              />
              <DefinitionRow
                label="Peers"
                value={formatWholeNumber(liveStatus?.network_peer_count ?? liveStatus?.public_peer_count)}
                detail={liveStatus?.network_peer_count != null
                  ? 'Unique peer dial targets published by the seed registry'
                  : 'Visible peers from the public RPC view'}
              />
            </div>
            <div className="settings-shell-endpoint-list">
              {[...(liveStatus?.bootnodes || []), ...(liveStatus?.seed_servers || [])].map((endpoint) => (
                <div key={`${endpoint.kind}-${endpoint.host}-${endpoint.port}`} className="settings-shell-endpoint-row">
                  <div>
                    <strong>{endpoint.host}</strong>
                    <span>{endpoint.ip_address}:{endpoint.port}</span>
                  </div>
                  <span className={`settings-shell-badge ${endpoint.reachable ? 'good' : 'bad'}`}>
                    {endpoint.kind}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="settings-shell-panel settings-shell-terminal-panel">
            <div className="settings-shell-panel-header">
              <div>
                <p className="settings-shell-panel-kicker">Operator Console</p>
                <h3>Guided machine diagnostics</h3>
              </div>
              <span className={`settings-shell-badge ${terminalBusy ? 'warn' : 'good'}`}>
                {terminalBusy ? 'Running' : 'Ready'}
              </span>
            </div>

            <div className="settings-shell-command-groups">
              {commandGroups.map((group) => (
                <div
                  key={group.id}
                  className={`settings-shell-command-group settings-shell-command-group-${group.accent}`}
                >
                  <span className="settings-shell-command-group-label">{group.title}</span>
                  {group.actions.length === 0 ? (
                    <span className="settings-shell-command-group-empty">
                      Use the terminal below for custom commands on this platform.
                    </span>
                  ) : (
                    group.actions.map((action) => (
                      <SNRGButton
                        key={action.id}
                        variant={action.variant}
                        size="sm"
                        disabled={terminalBusy}
                        title={action.description}
                        onClick={() => runTerminalCommand(action.command, {
                          actionId: action.id,
                          announceLabel: `${action.label}: ${action.description}`,
                          refreshAfterRun: action.refreshAfterRun,
                          successMessage: action.refreshAfterRun ? 'Local state refreshed after cleanup.' : '',
                        })}
                      >
                        {activeTerminalAction === action.id && terminalBusy ? 'Running...' : action.label}
                      </SNRGButton>
                    ))
                  )}
                </div>
              ))}
            </div>

            <div className="settings-shell-terminal">
              <div className="settings-shell-terminal-header">
                <div className="settings-shell-terminal-dots">
                  <span className="settings-shell-terminal-dot red"></span>
                  <span className="settings-shell-terminal-dot yellow"></span>
                  <span className="settings-shell-terminal-dot green"></span>
                </div>
                <code>{terminalCwd || '~'}</code>
              </div>
              <div className="settings-shell-terminal-body" ref={terminalScrollRef}>
                {terminalLines.map((line) => (
                  <div key={line.id} className={`settings-shell-terminal-line ${line.kind}`}>
                    <span className="settings-shell-terminal-time">{line.at}</span>
                    <span className="settings-shell-terminal-text">{line.text}</span>
                  </div>
                ))}
              </div>
              <form className="settings-shell-terminal-input-row" onSubmit={submitTerminal}>
                <span className="settings-shell-terminal-prompt">$</span>
                <input
                  value={terminalInput}
                  onChange={(event) => setTerminalInput(event.target.value)}
                  placeholder="Run your own local command (example: pwd)"
                  disabled={terminalBusy}
                />
                <SNRGButton
                  as="button"
                  type="submit"
                  variant="blue"
                  size="sm"
                  disabled={terminalBusy || !terminalInput.trim()}
                >
                  Run
                </SNRGButton>
              </form>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

export default SettingsPage;
