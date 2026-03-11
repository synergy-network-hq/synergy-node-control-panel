import { brandLogoSrc } from '../lib/runtimeAssets';

function StartupLoadingScreen({ progress, phase }) {
  const clamped = Math.max(0, Math.min(100, Number(progress || 0)));
  const showBar = clamped >= 8;
  const fadeOut = phase === 'fading';

  return (
    <section className={`startup-splash ${fadeOut ? 'is-fading-out' : ''}`}>
      <div className={`startup-logo-wrap ${showBar ? 'show' : ''}`}>
        <img src={brandLogoSrc} alt="Synergy Network" className="startup-logo" />
      </div>
      <div className={`startup-progress-wrap ${showBar ? 'show' : ''}`}>
        <div className="startup-progress-track">
          <div className="startup-progress-fill" style={{ width: `${clamped}%` }} />
        </div>
        <p className="startup-progress-text">{clamped}%</p>
      </div>
    </section>
  );
}

export default StartupLoadingScreen;
