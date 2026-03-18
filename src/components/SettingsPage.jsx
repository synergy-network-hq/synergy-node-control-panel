import { useCallback, useEffect, useMemo, useState } from 'react';
import { getVersion, invoke, openExternal, openPath } from '../lib/desktopClient';
import {
  applyTestnetBetaPortSettings,
  formatPortSettingsForForm,
  formatPortSettingsSummary,
  getTestnetBetaDefaultPortSettings,
  getTestnetBetaPortFields,
  readStoredTestnetBetaPortSettings,
  readTestnetBetaNodePortSettings,
  resetStoredTestnetBetaPortSettings,
  saveStoredTestnetBetaPortSettings,
  validateTestnetBetaPortSettingsForm,
} from '../lib/testnetBetaBootstrap';
import { SNRGButton } from '../styles/SNRGButton';

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

function SettingsPage() {
  const [state, setState] = useState(null);
  const [liveStatus, setLiveStatus] = useState(null);
  const [version, setVersion] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savedPortSettings, setSavedPortSettings] = useState(() => readStoredTestnetBetaPortSettings());
  const [portForm, setPortForm] = useState(() => formatPortSettingsForForm(readStoredTestnetBetaPortSettings()));
  const [portErrors, setPortErrors] = useState({});
  const [portMessage, setPortMessage] = useState('');
  const [portMessageTone, setPortMessageTone] = useState('good');
  const [portBusy, setPortBusy] = useState('');
  const [nodePortProfiles, setNodePortProfiles] = useState({});

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

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const [nextState, nextLiveStatus, nextVersion] = await Promise.all([
          invoke('testbeta_get_state'),
          invoke('testbeta_get_live_status'),
          getVersion(),
        ]);

        if (cancelled) {
          return;
        }

        const nextNodePortProfiles = await loadNodePortProfiles(nextState?.nodes);
        if (cancelled) {
          return;
        }

        setState(nextState);
        setLiveStatus(nextLiveStatus);
        setVersion(String(nextVersion || ''));
        setNodePortProfiles(nextNodePortProfiles);
        setError('');
      } catch (loadError) {
        if (!cancelled) {
          setError(String(loadError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [loadNodePortProfiles]);

  const storageRoot = useMemo(() => {
    const home = state?.device_profile?.home_directory;
    if (!home) {
      return '';
    }
    return `${home.replace(/[\\/]+$/, '')}/.synergy/testnet-beta`;
  }, [state?.device_profile?.home_directory]);

  const savedPortSummary = useMemo(
    () => formatPortSettingsSummary(savedPortSettings),
    [savedPortSettings],
  );
  const defaultPortSummary = useMemo(
    () => formatPortSettingsSummary(defaultPortSettings),
    [defaultPortSettings],
  );
  const provisionedNodes = Array.isArray(state?.nodes) ? state.nodes : [];

  const setPortNotice = useCallback((tone, message) => {
    setPortMessageTone(tone);
    setPortMessage(message);
  }, []);

  const refreshPortProfiles = useCallback(async (nodesInput) => {
    const nextProfiles = await loadNodePortProfiles(nodesInput);
    setNodePortProfiles(nextProfiles);
  }, [loadNodePortProfiles]);

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

  const settingsCards = useMemo(
    () => [
      {
        label: 'App Version',
        value: version || 'Not available',
        detail: 'Installed desktop build',
      },
      {
        label: 'Workspace Root',
        value: storageRoot || 'Not available',
        detail: 'Where node files are stored on this computer',
      },
      {
        label: 'Saved Port Profile',
        value: savedPortSummary,
        detail: 'Injected before setup, start, and sync',
      },
      {
        label: 'Bootnodes Online',
        value: formatEndpointStatus(liveStatus?.bootnodes),
        detail: 'Public bootstrap listeners responding',
      },
      {
        label: 'Seed Services Online',
        value: formatEndpointStatus(liveStatus?.seed_servers),
        detail: 'Public discovery services responding',
      },
    ],
    [liveStatus?.bootnodes, liveStatus?.seed_servers, savedPortSummary, storageRoot, version],
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
    <section className="nodecp-settings-page">
      <div className="nodecp-settings-hero">
        <div>
          <p className="nodecp-page-kicker">Settings</p>
          <h2 className="nodecp-page-title">Simple Operator Settings</h2>
          <p className="nodecp-page-copy">
            This page keeps only the settings an operator actually needs:
            where files live, what network this app is using, and whether the
            public entry points are healthy.
          </p>
        </div>
        <div className="nodecp-settings-actions">
          <SNRGButton variant="blue" size="md" onClick={() => storageRoot && openPath(storageRoot)}>
            Open Workspace Folder
          </SNRGButton>
          <SNRGButton variant="cyan" size="md" onClick={() => openExternal('https://testbeta-explorer.synergy-network.io')}>
            Open Explorer
          </SNRGButton>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="nodecp-stats-grid nodecp-settings-grid">
        {settingsCards.map((card) => (
          <article key={card.label} className="nodecp-stat-card">
            <span className="nodecp-stat-label">{card.label}</span>
            <strong className="nodecp-stat-value nodecp-stat-value-tight">{card.value}</strong>
            <span className="nodecp-stat-detail">{card.detail}</span>
          </article>
        ))}
      </div>

      <div className="nodecp-settings-sections">
        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">Application</p>
              <h3>What this app is using</h3>
            </div>
          </div>
          <div className="nodecp-definition-list">
            <div className="nodecp-definition-row">
              <span>Name</span>
              <strong>Synergy Node Control Panel</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Version</span>
              <strong>{version || 'Not available'}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Environment</span>
              <strong>{state?.display_name || 'Testnet-Beta'}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>This computer</span>
              <strong>{state?.device_profile?.hostname || 'Unknown'}</strong>
            </div>
          </div>
        </section>

        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">Storage</p>
              <h3>Files on this computer</h3>
            </div>
          </div>
          <div className="nodecp-definition-list">
            <div className="nodecp-definition-row">
              <span>Workspace root</span>
              <strong>{formatPath(storageRoot)}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Provisioned nodes</span>
              <strong>{state?.nodes?.length || 0}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Node folder</span>
              <strong>{formatPath(storageRoot ? `${storageRoot}/nodes` : '')}</strong>
            </div>
          </div>
        </section>

        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">Ports</p>
              <h3>Per-machine base port profile</h3>
            </div>
          </div>
          <p className="nodecp-panel-copy">
            Save one base profile for this machine. Electron applies a stable
            per-node offset before writing <code>node.toml</code> during
            provisioning, start, and sync, so multiple local nodes do not
            collide on the same P2P, RPC, WS, discovery, or metrics ports.
          </p>
          <div className="monitor-form-grid monitor-form-grid-wide">
            {portFields.map((field) => (
              <label key={field.key} className="monitor-field">
                <span>{field.label} Port</span>
                <input
                  type="number"
                  min="1"
                  max="65535"
                  inputMode="numeric"
                  value={portForm[field.key] ?? ''}
                  onChange={(event) => handlePortFieldChange(field.key, event.target.value)}
                />
                <span className="nodecp-settings-field-detail">{field.detail}</span>
                {portErrors[field.key] ? (
                  <span className="nodecp-settings-field-error">{portErrors[field.key]}</span>
                ) : null}
              </label>
            ))}
          </div>
          <div className="nodecp-controls-status">
            <span>Saved profile: {savedPortSummary}</span>
            <span>Default profile: {defaultPortSummary}</span>
          </div>
          <div className="nodecp-settings-actions nodecp-settings-actions-tight">
            <SNRGButton
              variant="blue"
              size="sm"
              disabled={portBusy === 'apply'}
              onClick={handleSavePortProfile}
            >
              Save Port Profile
            </SNRGButton>
            <SNRGButton
              variant="yellow"
              size="sm"
              disabled={portBusy === 'apply'}
              onClick={handleResetPortProfile}
            >
              Reset Defaults
            </SNRGButton>
            <SNRGButton
              variant="lime"
              size="sm"
              disabled={portBusy === 'apply' || provisionedNodes.length === 0}
              onClick={handleApplyPortProfileToExistingNodes}
            >
              {portBusy === 'apply' ? 'Applying...' : 'Apply To Existing Nodes'}
            </SNRGButton>
          </div>
          {portMessage ? (
            <div className="nodecp-controls-status">
              <span className={`nodecp-health-pill nodecp-health-${portMessageTone}`}>
                {portMessageTone === 'good' ? 'Saved' : portMessageTone === 'warn' ? 'Attention' : 'Error'}
              </span>
              <span>{portMessage}</span>
            </div>
          ) : null}
        </section>

        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">Network</p>
              <h3>Network health</h3>
            </div>
          </div>
          <div className="nodecp-definition-list">
            <div className="nodecp-definition-row">
              <span>Chain ID</span>
              <strong>{state?.network_profile?.chain_id || 'Unknown'}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Public RPC</span>
              <strong>{liveStatus?.public_rpc_endpoint || 'Not available'}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Discovery health</span>
              <strong>{liveStatus?.discovery_status || 'Unknown'}</strong>
            </div>
            <div className="nodecp-definition-row">
              <span>Live chain height</span>
              <strong>{formatWholeNumber(liveStatus?.public_chain_height)}</strong>
            </div>
          </div>
        </section>

        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">Endpoints</p>
              <h3>What new nodes will use</h3>
            </div>
          </div>
          <div className="nodecp-endpoint-stack">
            {(state?.network_profile?.bootnodes || []).map((endpoint) => (
              <div key={endpoint.host} className="nodecp-endpoint-row">
                <div>
                  <span className="nodecp-endpoint-name">{endpoint.host}</span>
                  <span className="nodecp-endpoint-meta">{endpoint.ip_address}:{endpoint.port}</span>
                </div>
                <span className="nodecp-endpoint-badge">Bootnode</span>
              </div>
            ))}
            {(state?.network_profile?.seed_servers || []).map((endpoint) => (
              <div key={endpoint.host} className="nodecp-endpoint-row">
                <div>
                  <span className="nodecp-endpoint-name">{endpoint.host}</span>
                  <span className="nodecp-endpoint-meta">{endpoint.ip_address}:{endpoint.port}</span>
                </div>
                <span className="nodecp-endpoint-badge nodecp-endpoint-badge-alt">Seed</span>
              </div>
            ))}
          </div>
        </section>

        <section className="nodecp-panel">
          <div className="nodecp-panel-header">
            <div>
              <p className="nodecp-panel-kicker">Node Ports</p>
              <h3>Current workspace configs</h3>
            </div>
          </div>
          <p className="nodecp-panel-copy">
            These values are read from each workspace&apos;s <code>node.toml</code>.
            If a node is already running, stop and start it after applying a new
            profile so the updated ports take effect.
          </p>
          {provisionedNodes.length === 0 ? (
            <div className="nodecp-empty-inline">
              No node workspaces have been created on this computer yet.
            </div>
          ) : (
            <div className="monitor-record-list">
              {provisionedNodes.map((node) => {
                const profile = nodePortProfiles[node.id];
                const nodeTomlPath = profile?.nodeTomlPath
                  || node?.config_paths?.find((entry) => String(entry).endsWith('/node.toml'))
                  || '';

                return (
                  <div key={node.id} className="monitor-record-row">
                    <div className="monitor-record-copy">
                      <strong>{node.display_label || node.label || node.id}</strong>
                      <span>
                        {profile?.ok
                          ? formatPortSettingsSummary(profile.portSettings)
                          : (profile?.error || 'Reading node port config...')}
                      </span>
                      <span>{formatPath(nodeTomlPath || node.workspace_directory)}</span>
                    </div>
                    <div className="monitor-record-actions">
                      <span className={`nodecp-health-pill nodecp-health-${profile?.ok ? 'good' : 'warn'}`}>
                        {profile?.ok ? 'Config Ready' : 'Needs Review'}
                      </span>
                      <SNRGButton
                        variant="blue"
                        size="sm"
                        disabled={!nodeTomlPath}
                        onClick={() => nodeTomlPath && openPath(nodeTomlPath)}
                      >
                        Open Config
                      </SNRGButton>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

export default SettingsPage;
