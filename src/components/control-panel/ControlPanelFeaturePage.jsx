import { useMemo, useState } from 'react';
import { SNRGButton } from '../../styles/SNRGButton';
import { useControlPanel } from './ControlPanelProvider';
import {
  formatNumber,
  nodeRuntimeLabel,
  nodeRuntimeTone,
  nodeSyncPercent,
} from './controlPanelModel';
import {
  JarvisCard,
  MetricCard,
  PanelCard,
  SectionHeader,
  StatusPill,
} from './ControlPanelShared';
import ActionAuditStream from './ActionAuditStream';
import JsonInspectorPanel from './JsonInspectorPanel';
import { getFeatureScreenByKey } from './controlPanelFeatureScreens';

function joinClasses(...values) {
  return values.filter(Boolean).join(' ');
}

function buildLiveMetrics(feature, selectedNodeLive, liveStatus, networkStats) {
  const syncPercent = nodeSyncPercent(selectedNodeLive, liveStatus);
  const liveCards = [
    {
      label: 'Selected node',
      value: nodeRuntimeLabel(selectedNodeLive),
      detail: `${formatNumber(selectedNodeLive?.local_peer_count ?? networkStats.totalPeers)} visible peers`,
      tone: nodeRuntimeTone(selectedNodeLive),
      icon: 'dns',
    },
    {
      label: 'Sync readiness',
      value: `${Math.round(syncPercent)}%`,
      detail: `${formatNumber(selectedNodeLive?.sync_gap ?? 0)} block gap`,
      tone: syncPercent >= 99 ? 'good' : syncPercent >= 80 ? 'warn' : 'bad',
      icon: 'sync',
    },
  ];

  return [...liveCards, ...feature.metrics].slice(0, 6);
}

function FeatureQuestionStrip({ questions }) {
  return (
    <div className="cp-feature-question-strip">
      {questions.map((item) => (
        <article key={item.label} className={`cp-feature-question tone-${item.tone || 'neutral'}`}>
          <span className="material-icons" aria-hidden="true">{item.icon}</span>
          <div>
            <small>{item.label}</small>
            <strong>{item.value}</strong>
          </div>
        </article>
      ))}
    </div>
  );
}

function FeatureChecklist({ title, items }) {
  return (
    <PanelCard title={title} detail="Safety and readiness checks for this workspace.">
      <div className="cp-feature-checklist">
        {items.map((item) => (
          <article key={item.label} className={`cp-feature-check tone-${item.tone || 'neutral'} ${item.done ? 'is-done' : ''}`}>
            <span className="material-icons" aria-hidden="true">{item.done ? 'check_circle' : 'radio_button_unchecked'}</span>
            <div>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
            </div>
          </article>
        ))}
      </div>
    </PanelCard>
  );
}

function FeatureTable({ title, columns, rows }) {
  return (
    <PanelCard title={title} detail="Operational rows are structured for scan-first review.">
      <div className="cp-feature-table">
        <div className="cp-feature-table-row cp-feature-table-head">
          {columns.map((column) => <span key={column}>{column}</span>)}
        </div>
        {rows.map((row) => (
          <div key={row.join('-')} className="cp-feature-table-row">
            {row.map((cell, index) => (
              <span key={`${cell}-${index}`} className={index === 0 ? 'is-primary' : ''}>{cell}</span>
            ))}
          </div>
        ))}
      </div>
    </PanelCard>
  );
}

function DangerWorkflow({ danger, onOpen }) {
  const [confirmText, setConfirmText] = useState('');
  const armed = confirmText.trim().toUpperCase() === 'REVIEW';

  if (!danger) {
    return null;
  }

  return (
    <PanelCard className="cp-feature-danger" title={danger.title} detail={danger.copy}>
      <div className="cp-feature-danger-body">
        <label className="cp-form-field">
          <span>Type REVIEW to open the guarded workflow</span>
          <input
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
            placeholder="REVIEW"
            autoComplete="off"
          />
        </label>
        <SNRGButton
          variant="red"
          size="sm"
          disabled={!armed}
          onClick={() => {
            onOpen();
            setConfirmText('');
          }}
        >
          {danger.confirmLabel}
        </SNRGButton>
      </div>
    </PanelCard>
  );
}

function Dot({ x, y, tone = 'cyan', shape = 'circle' }) {
  if (shape === 'triangle') {
    return <polygon points={`${x},${y - 5} ${x + 6},${y + 6} ${x - 6},${y + 6}`} className={`tone-${tone}`} />;
  }
  if (shape === 'diamond') {
    return <rect x={x - 5} y={y - 5} width="10" height="10" transform={`rotate(45 ${x} ${y})`} className={`tone-${tone}`} />;
  }
  return <circle cx={x} cy={y} r="5.5" className={`tone-${tone}`} />;
}

function DagVisual() {
  const nodes = [
    [8, 55, 'cyan', 'triangle'],
    [22, 38, 'cyan', 'diamond'],
    [22, 72, 'cyan', 'diamond'],
    [36, 25, 'cyan', 'diamond'],
    [36, 55, 'cyan', 'circle'],
    [36, 84, 'cyan', 'diamond'],
    [52, 36, 'cyan', 'diamond'],
    [52, 62, 'cyan', 'diamond'],
    [66, 45, 'warn', 'circle'],
    [66, 72, 'warn', 'diamond'],
    [80, 24, 'bad', 'circle'],
    [80, 50, 'warn', 'diamond'],
    [80, 76, 'bad', 'triangle'],
    [94, 55, 'bad', 'triangle'],
  ];
  const edges = [
    [8, 55, 22, 38], [8, 55, 22, 72], [22, 38, 36, 25], [22, 38, 36, 55],
    [22, 72, 36, 55], [22, 72, 36, 84], [36, 25, 52, 36], [36, 55, 52, 36],
    [36, 55, 52, 62], [36, 84, 52, 62], [52, 36, 66, 45], [52, 62, 66, 45],
    [52, 62, 66, 72], [66, 45, 80, 24], [66, 45, 80, 50], [66, 72, 80, 50],
    [66, 72, 80, 76], [80, 24, 94, 55], [80, 50, 94, 55], [80, 76, 94, 55],
  ];

  return (
    <div className="cp-feature-visual cp-feature-visual-dag">
      <svg viewBox="0 0 100 100" role="img" aria-label="DAG topology view">
        {edges.map((edge) => (
          <line key={edge.join('-')} x1={edge[0]} y1={edge[1]} x2={edge[2]} y2={edge[3]} />
        ))}
        {nodes.map((node) => (
          <Dot key={node.join('-')} x={node[0]} y={node[1]} tone={node[2]} shape={node[3]} />
        ))}
      </svg>
      <div className="cp-feature-legend">
        <span><i className="tone-cyan"></i>Finalized</span>
        <span><i className="tone-warn"></i>Pending</span>
        <span><i className="tone-bad"></i>Conflicting</span>
      </div>
    </div>
  );
}

function ConsensusVisual() {
  return (
    <div className="cp-feature-visual cp-feature-consensus">
      <div className="cp-feature-finality-line">
        {['Block', 'Vote', 'QC', 'Checkpoint', 'DAG Anchor', 'Finalized'].map((item, index) => (
          <div key={item} className={index < 5 ? 'is-complete' : ''}>
            <span>{index + 1}</span>
            <strong>{item}</strong>
          </div>
        ))}
      </div>
      <DagVisual />
    </div>
  );
}

function StorageVisual() {
  return (
    <div className="cp-feature-visual cp-feature-storage">
      <svg viewBox="0 0 360 170" role="img" aria-label="Storage growth forecast">
        <polyline points="12,145 70,124 128,100 184,72 240,45 305,28 348,18" />
        <line x1="12" y1="145" x2="348" y2="145" />
        <line x1="240" y1="22" x2="240" y2="145" className="warn-line" />
      </svg>
      <div className="cp-feature-donut" style={{ '--value': '76%' }}>
        <strong>76%</strong>
        <span>Projected capacity</span>
      </div>
    </div>
  );
}

function AlertsVisual() {
  return (
    <div className="cp-feature-visual cp-feature-alerts">
      {[
        ['Critical', 78, 'bad'],
        ['Warning', 56, 'warn'],
        ['Info', 34, 'cyan'],
        ['Recovered', 82, 'good'],
      ].map(([label, height, tone]) => (
        <div key={label} className="cp-feature-alert-bar">
          <span style={{ height: `${height}%` }} className={`tone-${tone}`}></span>
          <strong>{label}</strong>
        </div>
      ))}
    </div>
  );
}

function LifecycleVisual() {
  return (
    <div className="cp-feature-visual cp-feature-lifecycle">
      {['Registration', 'Activation', 'Performance', 'Exit'].map((step, index) => (
        <div key={step} className={index < 2 ? 'is-complete' : index === 2 ? 'is-active' : ''}>
          <span>{index + 1}</span>
          <strong>{step}</strong>
        </div>
      ))}
    </div>
  );
}

function GenericVisual({ type }) {
  if (type === 'dag') return <DagVisual />;
  if (type === 'consensus') return <ConsensusVisual />;
  if (type === 'storage') return <StorageVisual />;
  if (type === 'alerts') return <AlertsVisual />;
  if (type === 'lifecycle') return <LifecycleVisual />;

  return (
    <div className={joinClasses('cp-feature-visual', `cp-feature-visual-${type}`)}>
      <div className="cp-feature-signal-orbit">
        <span></span>
        <span></span>
        <span></span>
        <i className="material-icons" aria-hidden="true">
          {type === 'security' ? 'shield' : type === 'rpc' ? 'terminal' : type === 'fleet' ? 'lan' : type === 'governance' ? 'how_to_vote' : 'hub'}
        </i>
      </div>
      <div className="cp-feature-mini-grid">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <span key={index} className={index % 3 === 0 ? 'tone-purple' : index % 2 === 0 ? 'tone-good' : 'tone-cyan'}></span>
        ))}
      </div>
    </div>
  );
}

export default function ControlPanelFeaturePage({ screenKey }) {
  const feature = getFeatureScreenByKey(screenKey);
  const {
    actionAudit,
    liveStatus,
    networkStats,
    recordAction,
    selectedNode,
    selectedNodeLive,
    viewMode,
  } = useControlPanel();
  const [notice, setNotice] = useState('');
  const [localView, setLocalView] = useState('local');

  const liveMetrics = useMemo(
    () => (feature ? buildLiveMetrics(feature, selectedNodeLive, liveStatus, networkStats) : []),
    [feature, liveStatus, networkStats, selectedNodeLive],
  );

  if (!feature) {
    return null;
  }

  const handleAction = (action) => {
    const detail = `${action.label} opened for ${feature.title}.`;
    setNotice(detail);
    recordAction({
      title: action.label,
      detail,
      status: 'info',
      source: feature.key,
      command: action.id,
      payload: {
        screen: feature.key,
        nodeId: selectedNode?.id || null,
        viewMode,
      },
    });
  };

  const modeCopy = feature.modeCopy?.[viewMode] || feature.description;

  return (
    <div className="cp-page-stack cp-feature-page">
      <SectionHeader
        eyebrow={feature.eyebrow}
        title={feature.title}
        copy={modeCopy}
        actions={(
          <>
            <StatusPill tone={feature.tone}>{feature.label}</StatusPill>
            {feature.key === 'dag' ? (
              <div className="cp-feature-toggle">
                {['local', 'network'].map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={localView === option ? 'is-active' : ''}
                    onClick={() => setLocalView(option)}
                  >
                    {option === 'local' ? 'Local View' : 'Network View'}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
      />

      {notice ? <div className="cp-inline-notice">{notice}</div> : null}

      <FeatureQuestionStrip questions={feature.questions} />

      <div className="cp-dashboard-grid cp-feature-grid">
        <div className="cp-dashboard-main">
          <PanelCard
            className="cp-feature-hero"
            eyebrow={selectedNode?.display_label || 'Selected node'}
            title={feature.description}
            detail={`Current mode: ${viewMode}. Runtime status: ${nodeRuntimeLabel(selectedNodeLive)}.`}
            action={<StatusPill tone={nodeRuntimeTone(selectedNodeLive)} live>{nodeRuntimeLabel(selectedNodeLive)}</StatusPill>}
          >
            <GenericVisual type={feature.visual} />
          </PanelCard>

          <div className="cp-metric-grid cp-metric-grid-dashboard">
            {liveMetrics.map((metric) => (
              <MetricCard key={`${feature.key}-${metric.label}`} {...metric} />
            ))}
          </div>

          <div className="cp-split-grid">
            <FeatureChecklist title={feature.checklistTitle} items={feature.checklist} />
            <PanelCard title="Operator action center" detail="Actions record an audit entry and keep dangerous workflows explicit.">
              <div className="cp-feature-action-grid">
                {feature.actions.map((action) => (
                  <SNRGButton
                    key={action.id}
                    variant={action.variant}
                    size="sm"
                    onClick={() => handleAction(action)}
                  >
                    {action.label}
                  </SNRGButton>
                ))}
              </div>
              <div className="cp-feature-runtime-note">
                <span className="material-icons" aria-hidden="true">info</span>
                <p>Node-specific execution hooks can be attached here without changing the screen layout.</p>
              </div>
            </PanelCard>
          </div>

          <FeatureTable title={feature.tableTitle} columns={feature.tableColumns} rows={feature.tableRows} />

          <DangerWorkflow
            danger={feature.danger}
            onOpen={() => handleAction({ id: `${feature.key}-danger-review`, label: feature.danger.confirmLabel, variant: 'red' })}
          />
        </div>

        <div className="cp-dashboard-side">
          <JarvisCard
            mode={viewMode}
            title="Jarvis guidance"
            message={feature.jarvis}
            chips={[feature.label, selectedNode?.display_label || 'No node selected', nodeRuntimeLabel(selectedNodeLive)]}
          />

          <PanelCard title="Coverage map" detail="Spec areas represented by this screen.">
            <div className="cp-feature-coverage-list">
              {(feature.coverage || [
                feature.title,
                'Safety checks',
                'Operator action center',
                'Audit trail',
              ]).map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </PanelCard>

          <PanelCard title="Recent action audit" detail="Privileged and guided actions recorded in this session.">
            <ActionAuditStream entries={actionAudit.slice(0, 5)} emptyMessage="No actions recorded for this session yet." />
          </PanelCard>

          {viewMode === 'developer' ? (
            <JsonInspectorPanel
              title="Screen model"
              value={{
                screen: feature.key,
                selectedNodeId: selectedNode?.id || null,
                localView,
                metrics: liveMetrics,
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
