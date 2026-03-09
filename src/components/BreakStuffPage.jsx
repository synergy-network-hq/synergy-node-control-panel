import FutureLabPage from './FutureLabPage';

const capabilities = [
  {
    title: 'Stress and saturation tests',
    description: 'Drive the network under load to evaluate throughput ceilings, queue behavior, sync lag, and recovery under sustained pressure.',
  },
  {
    title: 'Adversarial node behavior',
    description: 'Stage byzantine or malicious scenarios against selected roles so validator, relayer, observer, and service responses can be studied safely.',
  },
  {
    title: 'Failure-injection drills',
    description: 'Coordinate disruption campaigns such as desync attempts, selective outages, bad data flows, and consensus edge cases with clear operator intent.',
  },
];

function BreakStuffPage() {
  return (
    <FutureLabPage
      eyebrow="Resilience Lab"
      title="Resilience Drills"
      subtitle="A future workspace for stress testing, fault injection, and malicious-behavior simulation."
      statusLabel="Future Update"
      intro="This area is reserved for deliberate network abuse testing. It will be used to pressure the devnet, create hostile conditions, and verify that consensus, monitoring, and recovery logic behave the way they should."
      capabilities={capabilities}
      futureNote="In a future update, this page will let you orchestrate test campaigns that intentionally destabilize or antagonize parts of the fleet so the network can be hardened against real failures."
      accent="red"
    />
  );
}

export default BreakStuffPage;
