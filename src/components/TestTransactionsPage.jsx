import FutureLabPage from './FutureLabPage';

const capabilities = [
  {
    title: 'Explorer-visible transfers',
    description: 'Send curated transaction types that are easy to recognize in Atlas and validate against node behavior, indexing, and wallet activity.',
  },
  {
    title: 'Scenario-driven payloads',
    description: 'Exercise contract calls, stake operations, governance actions, and malformed or edge-case transactions from a guided test surface.',
  },
  {
    title: 'Replayable operator runs',
    description: 'Capture transaction recipes so the same Testnet-Beta checks can be repeated after resets, installer updates, or protocol changes.',
  },
];

function TestTransactionsPage() {
  return (
    <FutureLabPage
      eyebrow="Transactions Lab"
      title="Test Transactions"
      subtitle="A dedicated control surface for generating explorer-visible Testnet-Beta activity."
      statusLabel="Future Update"
      intro="This page will become the transaction workbench for the control panel. It is intended to let you send purpose-built test traffic through the network and immediately confirm the result on the explorer."
      capabilities={capabilities}
      futureNote="In a future update, this page will let you choose transaction classes, target nodes or wallets, and push reproducible test activity into the network."
      accent="cyan"
    />
  );
}

export default TestTransactionsPage;
