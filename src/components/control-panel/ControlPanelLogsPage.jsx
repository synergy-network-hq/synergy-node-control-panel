import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { openPath, invoke } from '../../lib/desktopClient';
import { SNRGButton } from '../../styles/SNRGButton';
import { useControlPanel } from './ControlPanelProvider';
import {
  buildLogLevelCounts,
  formatNumber,
  safeArray,
  simplifyLogEntry,
  statusTone,
} from './controlPanelModel';
import {
  ActivityFeed,
  EmptyPanel,
  JarvisCard,
  MetricBars,
  PanelCard,
  SectionHeader,
  StatusPill,
} from './ControlPanelShared';

function matchesFilter(entry, filter, query) {
  const level = String(entry?.level || '').toUpperCase();
  const moduleText = String(entry?.module || '').toLowerCase();
  const sourceText = String(entry?.source_label || '').toLowerCase();
  const message = `${entry?.message || ''} ${entry?.raw || ''}`.toLowerCase();

  if (filter === 'error' && level !== 'ERROR') {
    return false;
  }
  if (filter === 'warn' && level !== 'WARN') {
    return false;
  }
  if (filter === 'network' && !/(peer|mesh|bootstrap|connect|dial|seed)/.test(message + moduleText)) {
    return false;
  }
  if (filter === 'chain' && !/(block|consensus|height|sync|quorum)/.test(message + moduleText)) {
    return false;
  }

  if (query) {
    return `${moduleText} ${sourceText} ${message}`.includes(query);
  }

  return true;
}

export default function ControlPanelLogsPage() {
  const {
    error,
    refresh,
    selectedNode,
    viewMode,
  } = useControlPanel();

  const [bundle, setBundle] = useState(null);
  const [loading, setLoading] = useState(false);
  const [logsError, setLogsError] = useState('');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const logsDirectory = selectedNode ? `${selectedNode.workspace_directory}/logs` : null;

  useEffect(() => {
    if (!selectedNode) {
      setBundle(null);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;

    const loadLogs = async () => {
      if (!cancelled) {
        setLoading(true);
      }

      try {
        const nextBundle = await invoke('testbeta_get_node_logs', {
          nodeId: selectedNode.id,
          lines: viewMode === 'developer' ? 900 : 260,
        });

        if (!cancelled) {
          setBundle(nextBundle || null);
          setLogsError('');
        }
      } catch (bundleError) {
        if (!cancelled) {
          setLogsError(String(bundleError));
          setBundle(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadLogs();
    const intervalId = window.setInterval(() => {
      void loadLogs();
    }, viewMode === 'developer' ? 2000 : 4000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [selectedNode, viewMode]);

  const entries = safeArray(bundle?.entries);
  const simplifiedEntries = entries.map((entry) => simplifyLogEntry(entry, viewMode));
  const filteredEntries = simplifiedEntries.filter((entry, index) => (
    matchesFilter(entries[index], filter, deferredSearch)
  ));
  const levelCounts = buildLogLevelCounts(entries);

  const logLevelBars = useMemo(() => ([
    {
      id: 'info',
      label: 'Info',
      value: formatNumber(levelCounts.INFO || 0),
      detail: 'Routine events',
      numericValue: Number(levelCounts.INFO || 0),
      tone: 'good',
    },
    {
      id: 'warn',
      label: 'Warnings',
      value: formatNumber(levelCounts.WARN || 0),
      detail: 'Needs attention soon',
      numericValue: Number(levelCounts.WARN || 0),
      tone: 'warn',
    },
    {
      id: 'error',
      label: 'Errors',
      value: formatNumber(levelCounts.ERROR || 0),
      detail: 'Critical issues',
      numericValue: Number(levelCounts.ERROR || 0),
      tone: 'bad',
    },
    {
      id: 'debug',
      label: 'Debug',
      value: formatNumber((levelCounts.DEBUG || 0) + (levelCounts.TRACE || 0)),
      detail: 'Deep developer traces',
      numericValue: Number((levelCounts.DEBUG || 0) + (levelCounts.TRACE || 0)),
      tone: 'neutral',
    },
  ]), [levelCounts.DEBUG, levelCounts.ERROR, levelCounts.INFO, levelCounts.TRACE, levelCounts.WARN]);

  if (!selectedNode) {
    return (
      <EmptyPanel
        title="No node selected for logs"
        copy="Provision or select a node to see live activity."
        actionLabel="Refresh"
        onAction={() => void refresh()}
      />
    );
  }

  return (
    <div className="cp-page-stack">
      <SectionHeader
        eyebrow={viewMode === 'basic' ? 'Friendly Feed' : viewMode === 'expert' ? 'Operations Feed' : 'Developer Feed'}
        title={viewMode === 'basic' ? 'System Activity' : viewMode === 'expert' ? 'System Logs' : 'Raw Runtime Logs'}
        copy={viewMode === 'basic'
          ? 'Jarvis translates the log stream into a daily activity feed.'
          : 'Filter event sources, severity, and raw runtime traces without leaving the control panel.'}
        actions={(
          <>
            <SNRGButton variant="blue" size="sm" onClick={() => void refresh()}>
              Refresh State
            </SNRGButton>
            {logsDirectory ? (
              <SNRGButton variant="blue" size="sm" onClick={() => openPath(logsDirectory)}>
                Open Log Folder
              </SNRGButton>
            ) : null}
          </>
        )}
      />

      {(logsError || error) ? (
        <div className={`cp-inline-notice tone-${statusTone(logsError || error)}`}>
          {logsError || error}
        </div>
      ) : null}

      <div className="cp-dashboard-grid">
        <div className="cp-dashboard-main">
          <JarvisCard
            mode={viewMode}
            title={viewMode === 'basic' ? 'Jarvis AI summary' : 'Log interpretation'}
            message={viewMode === 'basic'
              ? 'I am flattening the raw log stream into milestones, warnings, and successes so new operators can follow the node without reading terminal syntax.'
              : 'The log workspace now scales with the selected view. Basic abstracts, Expert filters, and Developer keeps the raw event payload intact.'}
            chips={[
              `${formatNumber(bundle?.summary?.total_entries ?? entries.length)} events`,
              `${formatNumber(bundle?.summary?.active_source_count ?? safeArray(bundle?.sources).length)} sources`,
              loading ? 'Updating' : 'Live',
            ]}
          />

          <MetricBars
            title="Severity mix"
            detail="Current event distribution pulled from the selected node workspace."
            items={logLevelBars}
          />

          <ActivityFeed
            title={viewMode === 'basic' ? 'Today’s important moments' : 'Filtered event feed'}
            detail={loading ? 'Updating the feed…' : `${formatNumber(filteredEntries.length)} visible events`}
            items={filteredEntries.slice(0, viewMode === 'developer' ? 10 : 8)}
            emptyMessage="No log events match the active filter."
          />
        </div>

        <div className="cp-dashboard-side">
          <PanelCard title="Filters" detail="Shape the feed without dropping into terminal search syntax.">
            <div className="cp-filter-stack">
              <div className="cp-chip-row cp-chip-row-wrap">
                {[
                  ['all', 'All events'],
                  ['network', 'Network'],
                  ['chain', 'Chain'],
                  ['warn', 'Warnings'],
                  ['error', 'Errors'],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`cp-chip cp-chip-button ${filter === value ? 'is-active' : ''}`}
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <label className="cp-form-field">
                <span>Search</span>
                <input
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search message, module, or source"
                />
              </label>

              {logsDirectory ? (
                <div className="cp-panel-inline-note">
                  Log path: <strong>{logsDirectory}</strong>
                </div>
              ) : null}
            </div>
          </PanelCard>

          <PanelCard
            title="Log sources"
            detail="Each source rolls up into the feed above."
          >
            <div className="cp-source-list">
              {safeArray(bundle?.sources).length ? safeArray(bundle?.sources).map((source) => (
                <article key={source.id} className="cp-source-item">
                  <div>
                    <strong>{source.label}</strong>
                    <span>{source.path || 'Source path unavailable'}</span>
                  </div>
                  <StatusPill tone={source.available ? 'good' : 'warn'}>
                    {source.available ? `${formatNumber(source.line_count)} lines` : 'Unavailable'}
                  </StatusPill>
                </article>
              )) : <div className="cp-empty-inline">Log sources will appear after the next refresh.</div>}
            </div>
          </PanelCard>

          {viewMode === 'developer' ? (
            <PanelCard
              title="Developer tail"
              detail="Newest raw entries with source and metadata."
            >
              <div className="cp-raw-log-list">
                {filteredEntries.slice(0, 12).map((entry) => (
                  <article key={entry.id} className={`cp-raw-log-item tone-${entry.tone}`}>
                    <div className="cp-raw-log-head">
                      <strong>{entry.level}</strong>
                      <span>{entry.sourceLabel}</span>
                      <small>{entry.time}</small>
                    </div>
                    <p>{entry.raw}</p>
                    {entry.metadata ? (
                      <pre>{JSON.stringify(entry.metadata, null, 2)}</pre>
                    ) : null}
                  </article>
                ))}
              </div>
            </PanelCard>
          ) : null}
        </div>
      </div>
    </div>
  );
}
