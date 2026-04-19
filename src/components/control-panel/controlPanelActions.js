import { invoke } from '../../lib/desktopClient';
import {
  applyStoredTestnetBetaPortSettings,
  formatPortSettingsSummary,
  refreshTestnetBetaBootstrapConfig,
} from '../../lib/testnetBetaBootstrap';

async function prepareNodeRuntime(node, network) {
  if (!node) {
    return '';
  }

  try {
    const portConfig = await applyStoredTestnetBetaPortSettings(node);
    const bootstrapConfig = await refreshTestnetBetaBootstrapConfig(node, network);
    const portNotice = portConfig.source === 'ceremony-package'
      ? `Ceremony ports preserved: ${formatPortSettingsSummary(portConfig.portSettings)}.`
      : `Port profile applied: ${formatPortSettingsSummary(portConfig.portSettings)}.`;
    const peerNotice = `Peers refreshed with ${bootstrapConfig.additionalDialTargets.length} discovered target(s).`;
    const warningNotice = bootstrapConfig.failures.length
      ? ` Warnings: ${bootstrapConfig.failures.join(' | ')}.`
      : '';
    return `${portNotice} ${peerNotice}${warningNotice}`.trim();
  } catch (error) {
    return `Bootstrap refresh skipped: ${String(error)}.`;
  }
}

export async function runNodeControlAction({ node, network, action }) {
  if (!node) {
    throw new Error('No node selected.');
  }

  let bootstrapNotice = '';
  if (action === 'start' || action === 'sync') {
    bootstrapNotice = await prepareNodeRuntime(node, network);
  }

  const result = await invoke('testbeta_node_control', {
    input: {
      nodeId: node.id,
      action,
    },
  });

  return {
    result,
    message: `${result?.message || `${action} completed.`}${bootstrapNotice ? ` ${bootstrapNotice}` : ''}`,
  };
}

export async function restartNodeAction({ node, network }) {
  if (!node) {
    throw new Error('No node selected.');
  }

  const bootstrapNotice = await prepareNodeRuntime(node, network);
  await invoke('testbeta_node_control', { input: { nodeId: node.id, action: 'stop' } });
  await invoke('testbeta_node_control', { input: { nodeId: node.id, action: 'start' } });

  return `Node restarted.${bootstrapNotice ? ` ${bootstrapNotice}` : ''}`;
}

export async function boostSyncAction(nodeId) {
  if (!nodeId) {
    throw new Error('No node selected.');
  }
  const result = await invoke('testbeta_boost_sync', { nodeId });
  return result?.message || 'Boost sync completed.';
}

export async function registerWithSeedsAction(nodeId) {
  if (!nodeId) {
    throw new Error('No node selected.');
  }
  const result = await invoke('testbeta_run_register_with_seeds', { nodeId });
  return result?.message || 'Registered with seed servers.';
}

export async function rejoinNetworkAction({ node, network }) {
  if (!node) {
    throw new Error('No node selected.');
  }
  const bootstrapNotice = await prepareNodeRuntime(node, network);
  const registerResult = await invoke('testbeta_run_register_with_seeds', { nodeId: node.id });
  await invoke('testbeta_node_control', { input: { nodeId: node.id, action: 'stop' } });
  await invoke('testbeta_node_control', { input: { nodeId: node.id, action: 'start' } });
  const registerMessage = registerResult?.message || 'Re-registered with seed peers.';
  return `Rejoined network. ${registerMessage}${bootstrapNotice ? ` ${bootstrapNotice}` : ''}`.trim();
}

export async function removeNodeAction(nodeId) {
  if (!nodeId) {
    throw new Error('No node selected.');
  }
  return invoke('testbeta_remove_node', {
    input: { node_id: nodeId },
  });
}
