import FutureLabPage from './FutureLabPage';

const capabilities = [
  {
    title: 'External network readiness',
    description: 'Track gateway deployments, chain endpoints, RPC health, and environment status for the testnets SXCP depends on.',
  },
  {
    title: 'Bridge operations visibility',
    description: 'Surface relayer, verifier, witness, and coordinator activity once Sepolia and Amoy connections are enabled.',
  },
  {
    title: 'Attestation and settlement checks',
    description: 'Inspect message flow, attestation progress, and cross-chain settlement outcomes from a single operational surface.',
  },
];

function SXCPDashboard() {
  return (
    <FutureLabPage
      eyebrow="Cross-Chain Operations"
      title="SXCP Operations Center"
      subtitle="A dedicated surface for Synergy cross-chain readiness, attestation flow, and external network coordination."
      statusLabel="External Networks Pending"
      intro="SXCP infrastructure is staged but external testnet integrations are not fully online yet. This page will become the operational console for bridge connectivity, relayer execution, and cross-chain attestations once those environments are enabled."
      capabilities={capabilities}
      futureNote="When Sepolia and Amoy are live in this environment, this surface will track gateway contracts, relayer queues, verifier activity, and settlement health across the full SXCP path."
      accent="cyan"
    />
  );
}

export default SXCPDashboard;
