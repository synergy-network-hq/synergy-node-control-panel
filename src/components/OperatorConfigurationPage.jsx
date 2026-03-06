import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Link } from 'react-router-dom';

const BULK_ACTIONS = [
  'status',
  'start',
  'stop',
  'restart',
  'reset_chain',
  'setup',
  'export_logs',
  'view_chain_data',
  'export_chain_data',
  'wireguard_status',
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
  const [loading, setLoading] = useState(true);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [error, setError] = useState('');

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
    machine_id: '',
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
      const [snapshotData, securityData] = await Promise.all([
        invoke('get_monitor_snapshot'),
        invoke('get_monitor_security_state'),
      ]);
      setSnapshot(snapshotData);
      setSecurityState(securityData);
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

  const activeRole = securityState?.active_role || 'viewer';
  const isAdmin = activeRole === 'admin';
  const operatorCount = securityState?.operators?.length || 0;
  const profileCount = securityState?.ssh_profiles?.length || 0;
  const bindingCount = securityState?.machine_bindings?.length || 0;
  const onlineNodes = snapshot?.online_nodes ?? 0;
  const totalNodes = snapshot?.total_nodes ?? 0;

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
        machine_id: newBinding.machine_id,
        profile_id: newBinding.profile_id,
        host_override: String(newBinding.host_override || '').trim() || null,
        remote_dir_override: String(newBinding.remote_dir_override || '').trim() || null,
      };
      const updated = await invoke('monitor_assign_machine_ssh_profile', { input: payload });
      setSecurityState(updated);
      setError('');
    } catch (err) {
      setError(String(err));
    }
  };

  const handleRemoveBinding = async (machineId) => {
    try {
      const updated = await invoke('monitor_remove_machine_ssh_profile', { machineId });
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
          <h2 className="monitor-hero-title">Synergy Devnet Control Panel Settings</h2>
          <p className="monitor-hero-summary">
            Manage operator identity, SSH reachability, node slot bindings, and fleet-wide control
            actions from one place.
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
        <article className="monitor-stat-card">
          <span className="monitor-stat-label">Node Slots</span>
          <strong className="monitor-stat-value">{totalNodes}</strong>
        </article>
        <article className="monitor-stat-card">
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
        <article className="monitor-stat-card">
          <span className="monitor-stat-label">Bound Slots</span>
          <strong className="monitor-stat-value">{bindingCount}</strong>
        </article>
      </div>

      <article className="monitor-panel monitor-panel-guide monitor-panel-span-3">
        <h3>How To Use This Page</h3>
        <p className="monitor-path">
          1) Set
          {' '}
          <strong>Active Operator</strong>
          {' '}
          first.
          2) Configure
          {' '}
          <strong>SSH Profiles</strong>
          .
          3) Bind node slots in
          {' '}
          <strong>Node Slot Binding</strong>
          .
          4) Run
          {' '}
          <strong>Fleet Bulk Actions</strong>
          .
        </p>
        <p className="monitor-path">
          Recommended defaults:
          {' '}
          <code>profile_id=ops</code>
          ,
          {' '}
          <code>ssh_user=ops</code>
          ,
          {' '}
          <code>ssh_port=22</code>
          ,
          {' '}
          <code>remote_root=/opt/synergy</code>
          .
        </p>
      </article>

      {error && (
        <div className="monitor-error-box">
          <strong>Configuration error:</strong>
          {' '}
          {truncate(error)}
        </div>
      )}

      <div className="monitor-admin-grid">
        <article className="monitor-panel monitor-panel-emphasis">
          <h3>Operator Access (RBAC)</h3>
          <p className="monitor-path">
            <strong>Set Active Operator:</strong>
            {' '}
            choose who is currently issuing actions.
          </p>
          <p className="monitor-path">
            <strong>Field presets:</strong>
            {' '}
            <code>operator_id</code>
            {' '}
            should be lowercase and stable (example:
            {' '}
            <code>ops_lead</code>
            ).
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

          <div className="monitor-chip-row">
            {(securityState?.operators || []).map((operator) => (
              <div key={operator.operator_id} className="monitor-chip">
                <span>
                  {operator.display_name}
                  {' '}
                  (
                  {operator.role}
                  )
                </span>
                {isAdmin && operator.operator_id !== securityState?.active_operator_id ? (
                  <button onClick={() => handleDeleteOperator(operator.operator_id)}>remove</button>
                ) : null}
              </div>
            ))}
          </div>
        </article>

        <article className="monitor-panel monitor-panel-span-2">
          <h3>SSH Profiles</h3>
          <p className="monitor-path">
            Saving an SSH profile does not generate SSH keys. Create keys manually first, then set
            {' '}
            <code>ssh_key_path</code>
            {' '}
            to the private key file.
          </p>
          <p className="monitor-path">
            Recommended profile template:
            {' '}
            <code>ops / Ops SSH Profile / ops / 22 / ~/.ssh/id_ed25519 /opt/synergy</code>
          </p>
          <div className="monitor-form-grid">
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

          <div className="monitor-chip-row">
            {(securityState?.ssh_profiles || []).map((profile) => (
              <div key={profile.profile_id} className="monitor-chip">
                <span>
                  {profile.label}
                  {' '}
                  (
                  {profile.ssh_user}
                  @:
                  {profile.ssh_port}
                  )
                </span>
                {isAdmin ? (
                  <button onClick={() => handleDeleteSshProfile(profile.profile_id)}>remove</button>
                ) : null}
              </div>
            ))}
          </div>

          <h4>Node Slot Binding</h4>
          <p className="monitor-path">
            Bind every node slot to one SSH profile unless a host-specific override is required.
          </p>
          <div className="monitor-form-grid">
            <select
              value={newBinding.machine_id}
              onChange={(event) => setNewBinding((prev) => ({ ...prev, machine_id: event.target.value }))}
            >
              <option value="">Select node slot</option>
              {nodes.map((entry) => (
                <option key={entry.node.machine_id} value={entry.node.machine_id}>
                  {entry.node.machine_id}
                  {' '}
                  (
                  {entry.node.physical_machine || 'unassigned host'}
                  )
                </option>
              ))}
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
            Bind Node Slot
          </button>

          <div className="monitor-chip-row">
            {(securityState?.machine_bindings || []).map((binding) => (
              <div key={binding.machine_id} className="monitor-chip">
                <span>
                  {binding.machine_id}
                  {' -> '}
                  {binding.profile_id}
                </span>
                {isAdmin ? (
                  <button onClick={() => handleRemoveBinding(binding.machine_id)}>remove</button>
                ) : null}
              </div>
            ))}
          </div>
        </article>

        <article className="monitor-panel monitor-panel-span-3">
          <h3>Fleet Bulk Actions</h3>
          <p className="monitor-path">
            Recommended startup sequence:
            {' '}
            <code>wireguard_install</code>
            {' -> '}
            <code>wireguard_connect</code>
            {' -> '}
            <code>wireguard_status</code>
            {' -> '}
            <code>status</code>
            .
          </p>
          <div className="monitor-form-grid">
            <select value={bulkAction} onChange={(event) => setBulkAction(event.target.value)}>
              {BULK_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>

            <select value={bulkScope} onChange={(event) => setBulkScope(event.target.value)}>
              <option value="all">all</option>
              {roleGroups.map((group) => (
                <option key={group} value={`role_group:${group}`}>
                  role_group:
                  {group}
                </option>
              ))}
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
            <div className="monitor-bulk-result">
              <p>
                Action
                {' '}
                <code>{bulkResult.action}</code>
                {' '}
                on
                {' '}
                <code>{bulkResult.scope}</code>
                {' | '}
                success:
                {' '}
                <strong>{bulkResult.succeeded}</strong>
                {' | '}
                failed:
                {' '}
                <strong>{bulkResult.failed}</strong>
              </p>
              <div className="monitor-chip-row">
                {(bulkResult.results || []).slice(0, 20).map((result) => (
                  <div key={`${result.machine_id}-${result.executed_at_utc}`} className="monitor-chip">
                    <span>
                      {result.machine_id}
                      :
                      {' '}
                      {result.success ? 'ok' : `fail (${result.exit_code})`}
                    </span>
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
