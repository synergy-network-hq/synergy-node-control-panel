import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADVANCED_NAV_GROUPS,
  BASIC_NAV_GROUPS,
  DEVELOPER_NAV_GROUPS,
  visibleControlPanelViews,
} from '../../src/components/control-panel/routeRegistry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function labels(groups) {
  return groups.flatMap((group) => group.items.map((item) => item.label));
}

function groupLabels(groups) {
  return groups.map((group) => group.label);
}

const basicLabels = labels(BASIC_NAV_GROUPS);
assert(
  JSON.stringify(basicLabels) === JSON.stringify(['Dashboard', 'My Node', 'Connections', 'Rewards', 'Activity', 'Settings', 'Help']),
  `Basic navigation mismatch: ${basicLabels.join(', ')}`,
);
assert(basicLabels.length === 7, 'Basic navigation must contain exactly seven visible links.');
assert(!basicLabels.some((label) => /Alerts|Validator|Security|Keys|Consensus|DAG|Transactions|Storage|API|Maintenance|Fleet/i.test(label)), 'Basic navigation exposes advanced/developer pages.');

assert(
  JSON.stringify(groupLabels(ADVANCED_NAV_GROUPS)) === JSON.stringify(['Monitor', 'Validator', 'Protocol', 'System', 'Utility']),
  `Advanced group labels mismatch: ${groupLabels(ADVANCED_NAV_GROUPS).join(', ')}`,
);
assert(
  JSON.stringify(groupLabels(DEVELOPER_NAV_GROUPS)) === JSON.stringify(['Runtime', 'Validator', 'Protocol', 'System', 'Utility']),
  `Developer group labels mismatch: ${groupLabels(DEVELOPER_NAV_GROUPS).join(', ')}`,
);
assert(!labels(ADVANCED_NAV_GROUPS).includes('Fleet'), 'Advanced navigation must not include Fleet.');
assert(!labels(DEVELOPER_NAV_GROUPS).includes('Fleet'), 'Developer navigation must not include Fleet.');

assert(JSON.stringify(visibleControlPanelViews(false)) === JSON.stringify(['basic', 'advanced']), 'Developer button must be hidden when developer mode is disabled.');
assert(JSON.stringify(visibleControlPanelViews(true)) === JSON.stringify(['basic', 'advanced', 'developer']), 'Developer button must appear when developer mode is enabled.');

const appSource = read('src/App.jsx');
assert(appSource.includes('DeveloperOnlyRoute'), 'Developer route guard is missing.');
assert(appSource.includes('path="/diagnostics"') || appSource.includes('screen.developerOnly'), 'Developer-only routes are not guarded.');
assert(appSource.includes('path="/fleet" element={<Navigate to="/" replace />}'), '/fleet compatibility redirect is missing.');
assert(appSource.includes('path="/activity" element={<ControlPanelLogsPage />}'), '/activity compatibility route is missing.');
assert(appSource.includes('path="/node/:nodeId" element={<Navigate to="/node" replace />}'), '/node/:id compatibility redirect is missing.');

const shellSource = read('src/components/control-panel/ControlPanelShell.jsx');
assert(!shellSource.includes('Node Slots'), 'Node Slots copy must not render in the shell.');
assert(!shellSource.includes('+ Setup a New Node'), 'Setup slot control must not render in the shell.');
assert(!shellSource.includes('cp-sidebar-jarvis'), 'Jarvis must not render as a sidebar entry.');
assert(shellSource.includes('cp-floating-jarvis-launcher'), 'Floating Jarvis launcher is missing.');
assert(shellSource.includes('aria-label="Open Help"'), 'Topbar Help button is missing.');

const nodeDetailsSource = read('src/components/control-panel/TestnetBetaNodeDetailRevamp.jsx');
assert(nodeDetailsSource.includes('Sync Catch Up'), 'Node Details must expose the dedicated Sync Catch Up workflow.');
for (const forbidden of ['Connect Wallet', 'Copy Deposit Address', 'Stake Validator', 'Stake SNRG', 'Unstake', 'Withdraw']) {
  assert(!nodeDetailsSource.includes(forbidden), `Node Details still contains forbidden wallet/stake control: ${forbidden}`);
}

const dashboardSource = read('src/components/control-panel/TestnetBetaDashboardRevamp.jsx');
assert(dashboardSource.includes('Sync Catch Up'), 'Dashboard must expose the dedicated Sync Catch Up workflow.');

const actionSource = read('src/components/control-panel/controlPanelActions.js');
assert(actionSource.includes('testbeta_sync_catch_up_rejoin'), 'Frontend action must call testbeta_sync_catch_up_rejoin.');

const controlServiceSource = read('control-service/src/testnet_beta.rs');
assert(controlServiceSource.includes('testbeta_sync_catch_up_rejoin'), 'Control service is missing the validator catch-up command.');
assert(controlServiceSource.includes('testbeta_activate_validator'), 'Catch-up command must be able to rejoin consensus through validator activation.');
assert(!controlServiceSource.includes('restart-based peer rejoin instead of offline fast-sync'), 'Validator sync must no longer skip offline fast-sync.');
assert(controlServiceSource.includes('testbeta_get_feature_snapshot'), 'Feature pages must load production feature snapshots from the control service.');

const rewardsSource = read('src/components/control-panel/ControlPanelRewardsPage.jsx');
for (const required of ['Connect Wallet', 'Copy Deposit Address', 'Stake SNRG', 'Unstake', 'Withdraw']) {
  assert(rewardsSource.includes(required), `Rewards is missing required wallet/stake control: ${required}`);
}
assert(!/synthetic|simulated/i.test(rewardsSource), 'Rewards must not render synthetic or simulated datasets.');

const featurePageSource = read('src/components/control-panel/ControlPanelFeaturePage.jsx');
assert(featurePageSource.includes('testbeta_get_feature_snapshot'), 'Feature pages must call the production snapshot command.');
assert(!featurePageSource.includes('No checks were returned'), 'Feature pages must not use unavailable-style placeholder check copy.');
assert(!featurePageSource.includes('No rows were returned'), 'Feature pages must not use unavailable-style placeholder table copy.');

const featureRegistrySource = read('src/components/control-panel/controlPanelFeatureScreens.js');
for (const forbidden of [
  'Critical alerts',
  'Voting uptime',
  'Commission revenue',
  'Tax statement',
  '421,891',
  'vtx-',
  'operator-grade scaffold',
  'synthetic',
  'simulated',
  'dummy',
  'mock',
]) {
  assert(!featureRegistrySource.toLowerCase().includes(forbidden.toLowerCase()), `Feature registry contains static/fake data marker: ${forbidden}`);
}

const runtimeInspectorSource = read('electron/ipc/runtime-inspector-ipc.cjs');
assert(!runtimeInspectorSource.includes('syntheticMeshCoordinate'), 'Peer topology must not synthesize private mesh coordinates.');
assert(!runtimeInspectorSource.includes('hashCoordinate'), 'Peer topology must not hash peer IDs into fake coordinates.');

assert(!/setJarvisInput\(['"]Genesis setup['"]\)/.test(shellSource), 'Post-setup Jarvis quick chips must not include Genesis setup.');
assert(shellSource.includes('Genesis setup is only available during the initial setup flow'), 'Jarvis typed genesis setup guard is missing.');

const settingsSource = read('src/components/SettingsPageCompact.jsx');
assert(settingsSource.includes('Enable Developer View'), 'Settings must include Enable Developer View.');
assert(settingsSource.includes('<details className="settings-shell-panel settings-shell-danger-zone">'), 'Settings danger zone must be a collapsed details accordion.');
assert(!settingsSource.includes('ERASE_NODE_DATA_TARGETS.map'), 'Settings must not map all OS wipe actions into prominent buttons.');

console.log('Control panel UI/UX revamp acceptance checks passed.');
