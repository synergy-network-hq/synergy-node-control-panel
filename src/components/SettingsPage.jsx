import { useEffect, useMemo, useState } from 'react';
import { getVersion, invoke, openExternal, openPath } from '../lib/desktopClient';
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

        setState(nextState);
        setLiveStatus(nextLiveStatus);
        setVersion(String(nextVersion || ''));
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
  }, []);

  const storageRoot = useMemo(() => {
    const home = state?.device_profile?.home_directory;
    if (!home) {
      return '';
    }
    return `${home.replace(/[\\/]+$/, '')}/.synergy/testnet-beta`;
  }, [state?.device_profile?.home_directory]);

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
    [liveStatus?.bootnodes, liveStatus?.seed_servers, storageRoot, version],
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
      </div>
    </section>
  );
}

export default SettingsPage;
