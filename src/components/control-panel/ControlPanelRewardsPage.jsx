import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { invoke } from '../../lib/desktopClient';
import { SNRGButton } from '../../styles/SNRGButton';
import { useControlPanel } from './ControlPanelProvider';
import {
  formatNumber,
  safeArray,
  statusTone,
} from './controlPanelModel';
import {
  EmptyPanel,
  JarvisCard,
  MetricCard,
  PanelCard,
  SectionHeader,
} from './ControlPanelShared';

function formatSnrg(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 'N/A';
  }

  return numeric.toLocaleString(undefined, {
    minimumFractionDigits: numeric < 100 ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

function formatPercentValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 'N/A';
  }
  return `${numeric.toFixed(2)}%`;
}

function formatHistoryTime(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 'Unknown';
  }
  return new Date(numeric * 1000).toLocaleString();
}

export default function ControlPanelRewardsPage() {
  const {
    error,
    refresh,
    selectedNode,
    viewMode,
  } = useControlPanel();

  const [rewardsData, setRewardsData] = useState(null);
  const [rewardsLoading, setRewardsLoading] = useState(false);
  const [rewardsError, setRewardsError] = useState('');

  useEffect(() => {
    if (!selectedNode) {
      setRewardsData(null);
      setRewardsError('');
      setRewardsLoading(false);
      return undefined;
    }

    let cancelled = false;

    const loadRewards = async () => {
      if (!cancelled) {
        setRewardsLoading(true);
      }

      try {
        const nextRewards = await invoke('get_rewards_data', { nodeId: selectedNode.id });
        if (!cancelled) {
          setRewardsData(nextRewards || null);
          setRewardsError('');
        }
      } catch (loadError) {
        if (!cancelled) {
          setRewardsData(null);
          setRewardsError(String(loadError));
        }
      } finally {
        if (!cancelled) {
          setRewardsLoading(false);
        }
      }
    };

    void loadRewards();

    return () => {
      cancelled = true;
    };
  }, [selectedNode]);

  const historyItems = useMemo(
    () => safeArray(rewardsData?.reward_history).slice(0, 12),
    [rewardsData?.reward_history],
  );

  if (!selectedNode) {
    return (
      <EmptyPanel
        title="No node selected for earnings"
        copy="Select or provision a node to inspect reward flow and validator economics."
        actionLabel="Refresh"
        onAction={() => void refresh()}
      />
    );
  }

  return (
    <div className="cp-page-stack">
      <SectionHeader
        eyebrow={viewMode === 'basic' ? 'Earnings View' : 'Rewards & Economics'}
        title={viewMode === 'basic' ? 'Rewards' : 'Rewards & Earnings'}
        copy={viewMode === 'basic'
          ? 'Track what this node has earned, what is still pending, and the basic trends that matter.'
          : 'Validator rewards, staking economics, payout trends, and recent reward history for the selected node.'}
        actions={(
          <>
            <SNRGButton variant="blue" size="sm" onClick={() => void refresh()}>
              Refresh State
            </SNRGButton>
            <SNRGButton as={Link} to={`/node/${selectedNode.id}`} variant="blue" size="sm">
              Node Details
            </SNRGButton>
          </>
        )}
      />

      {(rewardsError || error) ? (
        <div className={`cp-inline-notice tone-${statusTone(rewardsError || error)}`}>
          {rewardsError || error}
        </div>
      ) : null}

      <div className="cp-dashboard-grid">
        <div className="cp-dashboard-main">
          <div className="cp-metric-grid cp-metric-grid-dashboard">
            <MetricCard
              label="Lifetime earned"
              value={`${formatSnrg(rewardsData?.total_earned)} SNRG`}
              detail="All rewards reported for this node"
              tone="good"
              icon="savings"
            />
            <MetricCard
              label="Pending rewards"
              value={`${formatSnrg(rewardsData?.pending_rewards)} SNRG`}
              detail="Rewards not yet claimed or settled"
              tone="cyan"
              icon="schedule"
            />
            <MetricCard
              label="Total staked"
              value={`${formatSnrg(rewardsData?.staked_amount)} SNRG`}
              detail="Current bonded amount"
              tone="purple"
              icon="account_balance"
            />
            <MetricCard
              label="Estimated APY"
              value={formatPercentValue(rewardsData?.estimated_apy)}
              detail="Projected validator return"
              tone="warn"
              icon="trending_up"
            />
          </div>

          <PanelCard
            title="Earnings by period"
            detail={rewardsLoading ? 'Refreshing rewards feed…' : 'Recent payout windows for this node.'}
          >
            <div className="cp-period-grid">
              {[
                ['Last 24 hours', rewardsData?.last_24h],
                ['Last 7 days', rewardsData?.last_7d],
                ['Last 30 days', rewardsData?.last_30d],
              ].map(([label, value]) => (
                <article key={label} className="cp-period-card">
                  <span>{label}</span>
                  <strong>{formatSnrg(value)} SNRG</strong>
                </article>
              ))}
            </div>
          </PanelCard>

          <PanelCard
            title="Recent reward history"
            detail={historyItems.length ? 'Latest reward events returned by the control service.' : 'No reward history returned yet.'}
          >
            <div className="cp-reward-history">
              {historyItems.length ? historyItems.map((entry, index) => (
                <article key={`${entry?.timestamp || 'reward'}-${index}`} className="cp-reward-row">
                  <div>
                    <strong>{formatHistoryTime(entry?.timestamp)}</strong>
                    <span>{entry?.reward_type || 'validator reward'}</span>
                  </div>
                  <div className="cp-reward-row-meta">
                    <strong>+{formatSnrg(entry?.amount)} SNRG</strong>
                    <small>#{formatNumber(entry?.block_number)}</small>
                  </div>
                </article>
              )) : (
                <div className="cp-empty-inline">
                  No rewards data available yet. Start validating blocks to populate this history.
                </div>
              )}
            </div>
          </PanelCard>
        </div>

        <div className="cp-dashboard-side">
          <JarvisCard
            mode={viewMode}
            title={viewMode === 'basic' ? 'Jarvis earnings summary' : 'Economics insight'}
            message={viewMode === 'basic'
              ? 'This page keeps the reward story simple: how much this node has earned, what is pending, and whether earnings are trending in the right direction.'
              : 'This economics surface is where reward trends, APY, and settlement history stay visible without digging through logs or external dashboards.'}
            chips={[
              `${formatSnrg(rewardsData?.total_earned)} earned`,
              `${formatSnrg(rewardsData?.pending_rewards)} pending`,
              formatPercentValue(rewardsData?.estimated_apy),
            ]}
          />

          <PanelCard
            title="Economics details"
            detail="High-level validator payout parameters."
          >
            <div className="cp-definition-list">
              <div className="cp-definition-item">
                <span>Commission</span>
                <strong>{formatPercentValue(rewardsData?.commission_rate)}</strong>
              </div>
              <div className="cp-definition-item">
                <span>Pending claim</span>
                <strong>{Number(rewardsData?.pending_rewards) > 0 ? 'Available soon' : 'Nothing pending'}</strong>
              </div>
              <div className="cp-definition-item">
                <span>Node</span>
                <strong>{selectedNode.display_label || selectedNode.role_display_name || selectedNode.id}</strong>
              </div>
            </div>
          </PanelCard>
        </div>
      </div>
    </div>
  );
}
