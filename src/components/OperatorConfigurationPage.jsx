import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { invoke } from '../lib/desktopClient';

const BULK_ACTIONS = [
  'status',
  'start',
  'stop',
  'restart',
  'reset_chain',
  'setup',
  'install_node',
  'bootstrap_node',
  'export_logs',
  'view_chain_data',
  'export_chain_data',
  'rpc:get_node_status',
  'rpc:get_sync_status',
  'rpc:get_peer_info',
  'rpc:get_latest_block',
  'rpc:get_network_stats',
  'rpc:get_validator_activity',
  'rpc:get_relayer_set',
  'rpc:get_sxcp_status',
];

function truncate(value, max = 220) {
  if (!value) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function toSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function formatLocalTimestamp(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function OperatorConfigurationPage() {
  const [snapshot, setSnapshot] = useState(null);
  const [securityState, setSecurityState] = useState(null);
  const [agentSnapshot, setAgentSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [error, setError] = useState('');
  const [agentError, setAgentError] = useState('');

  const [bulkAction, setBulkAction] = useState('status');
  const [bulkScope, setBulkScope] = useState('all');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);

  const [newOperator, setNewOperator] = useState({
    operator_id: '',
    display_name: '',
    role: 'operator',
  });

  const [newSshProfile, setNewSshProfile] = useState({
    profile_id: 'ops',
    label: 'Ops SSH Profile',
    ssh_user: 'ops',
    ssh_port: '22',
    ssh_key_path: '~/.ssh/id_ed25519',
    remote_root: '/opt/synergy',
  });

  const [newBinding, setNewBinding] = useState({
    node_slot_id: '',
    profile_id: 'ops',
    host_override: '',
    remote_dir_override: '',
  });

  const fetchAll = async () => {
    try {
      if (!workspaceReady) {
        await invoke('monitor_initialize_workspace');
        setWorkspaceReady(true);
      }
      const [snapshotData, securityData, agentData] = await Promise.allSettled([
        invoke('get_monitor_snapshot'),
        invoke('get_monitor_security_state'),
        invoke('get_monitor_agent_snapshot'),
      ]);
      if (snapshotData.status !== 'fulfilled') throw snapshotData.reason;
      if (securityData.status !== 'fulfilled') throw securityData.reason;
      setSnapshot(snapshotData.value);
      setSecurityState(securityData.value);
      if (agentData.status === 'fulfilled') {
        setAgentSnapshot(agentData.value);
        setAgentError('');
      } else {
        setAgentSnapshot(null);
        setAgentError(String(agentData.reason));
      }
      setError('');
    } catch (err) {
      console.error('Failed loading operator configuration context:', err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, []);

  const nodes = snapshot?.nodes || [];
  const roleGroups = useMemo(() => {
    const set = new Set();
    nodes.forEach((entry) => {
      if (entry?.node?.role_group) set.add(String(entry.node.role_group));
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [nodes]);

  const physicalMachines = useMemo(() => {
    const set = new Set();
    nodes.forEach((entry) => {
      if (entry?.node?.physical_machine_id) set.add(String(entry.node.physical_machine_id));
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [nodes]);

  const activeRole = securityState?.active_role || 'viewer';
  const isAdmin = activeRole === 'admin';
  const operatorCount = securityState?.operators?.length || 0;
  const profileCount = securityState?.ssh_profiles?.length || 0;
  const bindingCount = securityState?.ssh_bindings?.length || 0;
  const onlineNodes = snapshot?.online_nodes ?? 0;
  const totalNodes = snapshot?.total_nodes ?? 0;
  const reachableAgents = agentSnapshot?.reachable_agents ?? 0;
  const totalAgents = agentSnapshot?.total_agents ?? 0;
  const activeOperator = (securityState?.operators || []).find(
    (operator) => operator.operator_id === securityState?.active_operator_id,
  );
  const bindingCoverage = totalNodes > 0 ? `${bindingCount}/${totalNodes}` : '0/0';
  const guideCards = [
    {
      kicker: '01',
      title: 'Choose the active operator',
      copy: 'Set the RBAC identity first so every later action runs under the correct admin/operator scope.',
    },
    {
      kicker: '02',
      title: 'Save SSH profiles',
      copy: 'Keep one stable profile for the fleet unless a machine truly needs a different user, key, or root path.',
    },
    {
      kicker: '03',
      title: 'Bind hosts or slots',
      copy: 'Bindings can target physical machines or logical node slots. Use overrides only when inventory defaults are wrong.',
    },
    {
      kicker: '04',
      title: 'Run bulk control safely',
      copy: 'Save bindings first, then use status and RPC checks on narrow scopes before you touch the entire fleet.',
    },
    {
      kicker: '05',
      title: 'Verify agent reachability',
      copy: 'Global reset/start/stop should only be attempted once every physical machine shows a reachable agent over the approved management network.',
    },
  ];
  const sectionLinks = [
    ['operator-access', 'Operator Access'],
    ['ssh-profiles', 'SSH Profiles'],
    ['bindings', 'Bindings'],
    ['agent-health', 'Agent Health'],
    ['bulk-actions', 'Bulk Actions'],
  ];

  const handleSetActiveOperator = async (operatorId) => {
    try {
      const updated = await invoke('monitor_set_active_operator', { operatorId });
      setSecurityState(updated);
      setError('');
    } catch (err) {
      setError(String(err));
    }
  };

  const handleCreateOperator = async () => {
    try {
      const payload = {
        operator_id: toSlug(newOperator.operator_id),
        display_name: String(newOperator.display_name || '').trim(),
        role: newOperator.role,
      };
      const updated = await invoke('monitor_upsert_operator', { input: payload });
      setSecurityState(updated);
      setError('');
      setNewOperator({ operator_id: '', display_name: '', role: 'operator' });
    } catch (err) {
      setError(String(err));
    }
  };

  const handleDeleteOperator = async (operatorId) => {
    try {
      const updated = await invoke('monitor_delete_operator', { operatorId });
      setSecurityState(updated);
      setError('');
    } catch (err) {
      setError(String(err));
    }
  };

  const handleCreateSshProfile = async () => {
    try {
      const payload = {
        profile_id: toSlug(newSshProfile.profile_id),
        label: String(newSshProfile.label || '').trim(),
        ssh_user: String(newSshProfile.ssh_user || '').trim(),
        ssh_port: Number(newSshProfile.ssh_port || 22),
        ssh_key_path: String(newSshProfile.ssh_key_path || '').trim() || null,
        remote_root: String(newSshProfile.remote_root || '').trim() || null,
        strict_host_key_checking: null,
        extra_ssh_args: null,
      };
      const updated = await invoke('monitor_upsert_ssh_profile', { input: payload });
      setSecurityState(updated);
      setError('');
    } catch (err) {
      setError(String(err));
    }
  };

  const handleDeleteSshProfile = async (profileId) => {
    try {
      const updated = await invoke('monitor_delete_ssh_profile', { profileId });
      setSecurityState(updated);
      setError('');
    } catch (err) {
      setError(String(err));
    }
  };

  const handleAssignBinding = async () => {
    try {
      const payload = {
        node_slot_id: newBinding.node_slot_id,
        profile_id: newBinding.profile_id,
        host_override: String(newBinding.host_override || '').trim() || null,
        remote_dir_override: String(newBinding.remote_dir_override || '').trim() || null,
      };
      const updated = await invoke('monitor_assign_ssh_binding', { input: payload });
      setSecurityState(updated);
      setError('');
    } catch (err) {
      setError(String(err));
    }
  };

  const handleRemoveBinding = async (nodeSlotId) => {
    try {
      const updated = await invoke('monitor_remove_ssh_binding', { nodeSlotId });
      setSecurityState(updated);
      setError('');
    } catch (err) {
      setError(String(err));
    }
  };

  const handleBulkAction = async () => {
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const result = await invoke('monitor_bulk_node_control', {
        action: bulkAction,
        scope: bulkScope,
      });
      setBulkResult(result);
      await fetchAll();
    } catch (err) {
      setBulkResult({ error: String(err) });
    } finally {
      setBulkBusy(false);
    }
  };

  if (loading) {
    return (
      <section className="monitor-shell">
        <div className="loading-container">
          <div className="spinner"></div>
          <p>Loading operator configuration...</p>
        </div>
      </section>
    );
  }

  return (
    <section className="monitor-shell monitor-shell-operator">
      <div className="monitor-page-hero monitor-page-hero-operator">
        <div className="monitor-hero-copy">
          <p className="monitor-hero-eyebrow">Operations + Security</p>
          <h2 className="monitor-hero-title">Synergy Node Control Panel Settings</h2>
          <p className="monitor-hero-summary">
            Manage operator identity, SSH reachability, control bindings, and fleet-wide actions
            from one deliberate operations surface.
          </p>
          <div className="monitor-inline-pills">
            <span className="monitor-inline-pill monitor-inline-pill-healthy">
              Active
              {' '}
              {securityState?.active_operator_id || 'N/A'}
            </span>
            <span className="monitor-inline-pill">{activeRole}</span>
            <span className="monitor-inline-pill">
              Snapshot
              {' '}
              {formatLocalTimestamp(snapshot?.captured_at_utc)}
            </span>
            <span className="monitor-inline-pill">
              Coverage
              {' '}
              {bindingCoverage}
            </span>
          </div>
          <p className="monitor-path">
            Workspace:
            {' '}
            <code>{securityState?.workspace_path || 'N/A'}</code>
          </p>
        </div>
        <div className="monitor-hero-actions">
          <Link className="monitor-link-btn" to="/">
            Back to Dashboard
          </Link>
          <button className="monitor-btn monitor-btn-primary" onClick={fetchAll}>
            Refresh
          </button>
        </div>
      </div>

      <div className="monitor-stat-grid">
        <article className="monitor-stat-card monitor-stat-card-healthy">
          <span className="monitor-stat-label">Node Slots</span>
          <strong className="monitor-stat-value">{totalNodes}</strong>
        </article>
        <article className="monitor-stat-card monitor-stat-card-healthy">
          <span className="monitor-stat-label">Online Now</span>
          <strong className="monitor-stat-value">{onlineNodes}</strong>
        </article>
        <article className="monitor-stat-card">
          <span className="monitor-stat-label">Operators</span>
          <strong className="monitor-stat-value">{operatorCount}</strong>
        </article>
        <article className="monitor-stat-card">
          <span className="monitor-stat-label">SSH Profiles</span>
          <strong className="monitor-stat-value">{profileCount}</strong>
        </article>
        <article className="monitor-stat-card monitor-stat-card-degraded">
          <span className="monitor-stat-label">Binding Coverage</span>
          <strong className="monitor-stat-value">{bindingCoverage}</strong>
        </article>
        <article className={`monitor-stat-card ${totalAgents > 0 && reachableAgents === totalAgents ? 'monitor-stat-card-healthy' : 'monitor-stat-card-degraded'}`}>
          <span className="monitor-stat-label">Agents Reachable</span>
          <strong className="monitor-stat-value">
            {reachableAgents}
            /
            {totalAgents}
          </strong>
        </article>
      </div>

      <nav className="monitor-section-nav">
        {sectionLinks.map(([id, label]) => (
          <a key={id} className="monitor-section-nav-chip" href={`#${id}`}>
            {label}
          </a>
        ))}
      </nav>

      <div className="monitor-settings-guide-grid">
        {guideCards.map((card) => (
          <article key={card.kicker} className="monitor-settings-guide-card">
            <span className="monitor-settings-guide-kicker">{card.kicker}</span>
            <strong>{card.title}</strong>
            <p>{card.copy}</p>
          </article>
        ))}
      </div>

      {error && (
        <div className="monitor-error-box">
          <strong>Configuration error:</strong>
          {' '}
          {truncate(error)}
        </div>
      )}

      <div className="monitor-admin-grid">
        <article id="operator-access" className="monitor-panel monitor-panel-emphasis">
          <div className="monitor-card-heading">
            <div>
              <p className="monitor-card-kicker">RBAC</p>
              <h3>Operator Access</h3>
            </div>
            <span className="monitor-inline-pill">{activeOperator?.display_name || 'No active operator'}</span>
          </div>
          <p className="monitor-path">
            Set the active identity before running any control action. Admin is required for
            security configuration and destructive fleet operations.
          </p>
          <label className="monitor-field">
            Active Operator
            <select
              value={securityState?.active_operator_id || ''}
              onChange={(event) => handleSetActiveOperator(event.target.value)}
            >
              {(securityState?.operators || []).map((operator) => (
                <option key={operator.operator_id} value={operator.operator_id}>
                  {operator.display_name}
                  {' '}
                  (
                  {operator.role}
                  )
                </option>
              ))}
            </select>
          </label>

          <div className="monitor-form-inline">
            <input
              placeholder="operator_id (e.g., ops_lead)"
              value={newOperator.operator_id}
              onChange={(event) => setNewOperator((prev) => ({ ...prev, operator_id: event.target.value }))}
            />
            <input
              placeholder="display name"
              value={newOperator.display_name}
              onChange={(event) => setNewOperator((prev) => ({ ...prev, display_name: event.target.value }))}
            />
            <select
              value={newOperator.role}
              onChange={(event) => setNewOperator((prev) => ({ ...prev, role: event.target.value }))}
            >
              <option value="viewer">viewer</option>
              <option value="operator">operator</option>
              <option value="admin">admin</option>
            </select>
            <button className="monitor-btn" onClick={handleCreateOperator} disabled={!isAdmin}>
              Add Operator
            </button>
          </div>

          <div className="monitor-record-list">
            {(securityState?.operators || []).map((operator) => (
              <div key={operator.operator_id} className="monitor-record-row">
                <div className="monitor-record-copy">
                  <strong>{operator.display_name}</strong>
                  <span>
                    {operator.operator_id}
                    {' · '}
                    {operator.role}
                    {' · updated '}
                    {formatLocalTimestamp(operator.updated_at_utc)}
                  </span>
                </div>
                <div className="monitor-record-actions">
                  {operator.operator_id === securityState?.active_operator_id ? (
                    <span className="monitor-action-tag monitor-action-tag-role">active</span>
                  ) : null}
                  {isAdmin && operator.operator_id !== securityState?.active_operator_id ? (
                    <button className="monitor-btn" onClick={() => handleDeleteOperator(operator.operator_id)}>
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </article>

        <article id="ssh-profiles" className="monitor-panel monitor-panel-span-2">
          <div className="monitor-card-heading">
            <div>
              <p className="monitor-card-kicker">Transport</p>
              <h3>SSH Profiles</h3>
            </div>
            <span className="monitor-inline-pill">{profileCount} profile(s)</span>
          </div>
          <p className="monitor-path">
            Recommended baseline:
            {' '}
            <code>ops / Ops SSH Profile / ops / 22 / ~/.ssh/id_ed25519 /opt/synergy</code>
          </p>
          <div className="monitor-form-grid monitor-form-grid-wide">
            <input
              placeholder="profile_id"
              value={newSshProfile.profile_id}
              onChange={(event) => setNewSshProfile((prev) => ({ ...prev, profile_id: event.target.value }))}
            />
            <input
              placeholder="label"
              value={newSshProfile.label}
              onChange={(event) => setNewSshProfile((prev) => ({ ...prev, label: event.target.value }))}
            />
            <input
              placeholder="ssh user"
              value={newSshProfile.ssh_user}
              onChange={(event) => setNewSshProfile((prev) => ({ ...prev, ssh_user: event.target.value }))}
            />
            <input
              placeholder="ssh port"
              value={newSshProfile.ssh_port}
              onChange={(event) => setNewSshProfile((prev) => ({ ...prev, ssh_port: event.target.value }))}
            />
            <input
              placeholder="ssh key path (optional)"
              value={newSshProfile.ssh_key_path}
              onChange={(event) => setNewSshProfile((prev) => ({ ...prev, ssh_key_path: event.target.value }))}
            />
            <input
              placeholder="remote root"
              value={newSshProfile.remote_root}
              onChange={(event) => setNewSshProfile((prev) => ({ ...prev, remote_root: event.target.value }))}
            />
          </div>
          <button className="monitor-btn" onClick={handleCreateSshProfile} disabled={!isAdmin}>
            Save SSH Profile
          </button>

          <div className="monitor-record-list">
            {(securityState?.ssh_profiles || []).map((profile) => (
              <div key={profile.profile_id} className="monitor-record-row">
                <div className="monitor-record-copy">
                  <strong>{profile.label}</strong>
                  <span>
                    {profile.profile_id}
                    {' · '}
                    {profile.ssh_user}
                    {' @ '}
                    {profile.ssh_port}
                    {' · root '}
                    {profile.remote_root || '/opt/synergy'}
                  </span>
                </div>
                <div className="monitor-record-actions">
                  {profile.ssh_key_path ? (
                    <span className="monitor-action-tag">keyed</span>
                  ) : (
                    <span className="monitor-action-tag monitor-action-tag-disabled">no key path</span>
                  )}
                  {isAdmin ? (
                    <button className="monitor-btn" onClick={() => handleDeleteSshProfile(profile.profile_id)}>
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </article>

        <article id="bindings" className="monitor-panel monitor-panel-span-2">
          <div className="monitor-card-heading">
            <div>
              <p className="monitor-card-kicker">Reachability</p>
              <h3>Bindings</h3>
            </div>
            <span className="monitor-inline-pill">{bindingCoverage}</span>
          </div>
          <p className="monitor-path">
            Bind by physical machine when one host serves multiple slots. Bind by node slot when a
            specific logical node needs an exception.
          </p>
          <div className="monitor-form-grid monitor-form-grid-wide">
            <select
              value={newBinding.node_slot_id}
              onChange={(event) => setNewBinding((prev) => ({ ...prev, node_slot_id: event.target.value }))}
            >
              <option value="">Select binding target</option>
              {physicalMachines.length > 0 && (
                <optgroup label="Physical Machines">
                  {physicalMachines.map((machineId) => (
                    <option key={machineId} value={machineId}>
                      {machineId}
                    </option>
                  ))}
                </optgroup>
              )}
              {nodes.length > 0 && (
                <optgroup label="Node Slots">
                  {nodes.map((entry) => (
                    <option key={entry.node.node_slot_id} value={entry.node.node_slot_id}>
                      {entry.node.node_slot_id}
                      {' '}
                      (
                      {entry.node.physical_machine_id || 'unassigned host'}
                      )
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <select
              value={newBinding.profile_id}
              onChange={(event) => setNewBinding((prev) => ({ ...prev, profile_id: event.target.value }))}
            >
              <option value="">Select profile</option>
              {(securityState?.ssh_profiles || []).map((profile) => (
                <option key={profile.profile_id} value={profile.profile_id}>
                  {profile.label}
                </option>
              ))}
            </select>
            <input
              placeholder="host override (optional)"
              value={newBinding.host_override}
              onChange={(event) => setNewBinding((prev) => ({ ...prev, host_override: event.target.value }))}
            />
            <input
              placeholder="remote dir override (optional)"
              value={newBinding.remote_dir_override}
              onChange={(event) => setNewBinding((prev) => ({ ...prev, remote_dir_override: event.target.value }))}
            />
          </div>
          <button className="monitor-btn" onClick={handleAssignBinding} disabled={!isAdmin}>
            Save Binding
          </button>

          <div className="monitor-record-list">
            {(securityState?.ssh_bindings || []).map((binding) => (
              <div key={binding.node_slot_id} className="monitor-record-row">
                <div className="monitor-record-copy">
                  <strong>{binding.node_slot_id}</strong>
                  <span>
                    profile {binding.profile_id}
                    {binding.host_override ? ` · host ${binding.host_override}` : ''}
                    {binding.remote_dir_override ? ` · dir ${binding.remote_dir_override}` : ''}
                  </span>
                </div>
                <div className="monitor-record-actions">
                  {isAdmin ? (
                    <button className="monitor-btn" onClick={() => handleRemoveBinding(binding.node_slot_id)}>
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </article>

        <article id="agent-health" className="monitor-panel monitor-panel-span-3">
          <div className="monitor-card-heading">
            <div>
              <p className="monitor-card-kicker">Private Control Plane</p>
              <h3>Agent Health / Reachability</h3>
            </div>
            <span className={`monitor-inline-pill monitor-inline-pill-${totalAgents > 0 && reachableAgents === totalAgents ? 'healthy' : 'degraded'}`}>
              {reachableAgents}
              /
              {totalAgents || 0}
              {' '}
              reachable
            </span>
          </div>
          <p className="monitor-path">
            Global lifecycle/reset actions use the per-machine agent over the management network first and fall back to SSH only when the agent is unavailable.
          </p>

          {agentError ? (
            <div className="monitor-error-box">
              <strong>Agent probe error:</strong>
              {' '}
              {truncate(agentError)}
            </div>
          ) : null}

          {agentSnapshot ? (
            <div className="monitor-bulk-result-shell">
              <div className="monitor-bulk-result-summary">
                <div>
                  <span>Total Machines</span>
                  <strong>{agentSnapshot.total_agents}</strong>
                </div>
                <div>
                  <span>Reachable</span>
                  <strong>{agentSnapshot.reachable_agents}</strong>
                </div>
                <div>
                  <span>Unreachable</span>
                  <strong>{agentSnapshot.unreachable_agents}</strong>
                </div>
                <div>
                  <span>Last Probe</span>
                  <strong>{formatLocalTimestamp(agentSnapshot.captured_at_utc)}</strong>
                </div>
              </div>

              <div className="monitor-record-list">
                {(agentSnapshot.agents || []).map((agent) => (
                  <div key={`${agent.physical_machine_id}-${agent.management_host}`} className="monitor-record-row">
                    <div className="monitor-record-copy">
                      <strong>{agent.physical_machine_id}</strong>
                      <span>
                        {agent.management_host}
                        {' · '}
                        {agent.version || 'no version reported'}
                        {' · '}
                        {agent.response_ms}
                        ms
                      </span>
                      <span>
                        node slots:
                        {' '}
                        {agent.node_slot_ids.join(', ')}
                      </span>
                      <span>
                        {agent.error
                          ? truncate(agent.error)
                          : `workspace ${truncate(agent.workspace_path || 'N/A', 120)}`}
                      </span>
                    </div>
                    <div className="monitor-record-actions">
                      {agent.local_management_host ? (
                        <span className="monitor-action-tag">
                          local
                          {' '}
                          {agent.local_management_host}
                        </span>
                      ) : null}
                      {(agent.supported_actions || []).slice(0, 3).map((action) => (
                        <span key={`${agent.physical_machine_id}-${action}`} className="monitor-action-tag">
                          {action}
                        </span>
                      ))}
                      <span className={`monitor-action-tag ${agent.reachable ? 'monitor-action-tag-role' : 'monitor-action-tag-disabled'}`}>
                        {agent.reachable ? 'reachable' : 'offline'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="monitor-path">No agent probe results loaded yet.</p>
          )}
        </article>

        <article id="bulk-actions" className="monitor-panel monitor-panel-span-3 monitor-panel-guide">
          <div className="monitor-card-heading">
            <div>
              <p className="monitor-card-kicker">Fleet Control</p>
              <h3>Bulk Actions</h3>
            </div>
            <span className={`monitor-inline-pill monitor-inline-pill-${bulkBusy ? 'degraded' : 'healthy'}`}>
              {bulkBusy ? 'running' : 'ready'}
            </span>
          </div>
          <div className="monitor-settings-guide-grid monitor-settings-guide-grid-compact">
            <article className="monitor-settings-guide-card">
              <span className="monitor-settings-guide-kicker">Safe Sequence</span>
              <strong>Bindings first, then health checks</strong>
              <p>
                <code>status</code>
                {' -> '}
                <code>rpc:get_sync_status</code>
                {' -> '}
                <code>rpc:get_peer_info</code>
              </p>
            </article>
            <article className="monitor-settings-guide-card">
              <span className="monitor-settings-guide-kicker">Scope</span>
              <strong>Prefer narrow scopes</strong>
              <p>Use role-group or physical-machine scopes before you escalate to `all`.</p>
            </article>
            <article className="monitor-settings-guide-card">
              <span className="monitor-settings-guide-kicker">Readback</span>
              <strong>Watch result counts</strong>
              <p>Success and failure counts tell you quickly whether the issue is auth, reachability, or node runtime.</p>
            </article>
          </div>
          <div className="monitor-form-grid monitor-form-grid-wide">
            <select value={bulkAction} onChange={(event) => setBulkAction(event.target.value)}>
              {BULK_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>

            <select value={bulkScope} onChange={(event) => setBulkScope(event.target.value)}>
              <option value="all">all</option>
              {roleGroups.length > 0 && (
                <optgroup label="Role Groups">
                  {roleGroups.map((group) => (
                    <option key={group} value={`role_group:${group}`}>
                      role_group:{group}
                    </option>
                  ))}
                </optgroup>
              )}
              {physicalMachines.length > 0 && (
                <optgroup label="Physical Machines">
                  {physicalMachines.map((machineId) => (
                    <option key={machineId} value={machineId}>
                      {machineId}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          <button className="monitor-btn monitor-btn-primary" onClick={handleBulkAction} disabled={bulkBusy}>
            {bulkBusy ? 'Executing...' : 'Execute Bulk Action'}
          </button>

          {bulkResult?.error ? (
            <div className="monitor-error-box">
              <strong>Bulk action failed:</strong>
              {' '}
              {bulkResult.error}
            </div>
          ) : null}

          {bulkResult && !bulkResult.error ? (
            <div className="monitor-bulk-result monitor-bulk-result-shell">
              <div className="monitor-bulk-result-summary">
                <div>
                  <span>Action</span>
                  <strong>{bulkResult.action}</strong>
                </div>
                <div>
                  <span>Scope</span>
                  <strong>{bulkResult.scope}</strong>
                </div>
                <div>
                  <span>Succeeded</span>
                  <strong>{bulkResult.succeeded}</strong>
                </div>
                <div>
                  <span>Failed</span>
                  <strong>{bulkResult.failed}</strong>
                </div>
              </div>
              <div className="monitor-record-list">
                {(bulkResult.results || []).slice(0, 20).map((result) => (
                  <div key={`${result.node_slot_id}-${result.executed_at_utc}`} className="monitor-record-row">
                    <div className="monitor-record-copy">
                      <strong>{result.node_slot_id}</strong>
                      <span>
                        exit {result.exit_code}
                        {' · '}
                        {formatLocalTimestamp(result.executed_at_utc)}
                      </span>
                    </div>
                    <div className="monitor-record-actions">
                      <span className={`monitor-action-tag ${result.success ? 'monitor-action-tag-role' : 'monitor-action-tag-disabled'}`}>
                        {result.success ? 'ok' : 'failed'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </article>
      </div>
    </section>
  );
}

export default OperatorConfigurationPage;
