import { brandLogoSrc } from '../lib/runtimeAssets';

function StartupLoadingScreen({ progress, phase }) {
  const clamped = Math.max(0, Math.min(100, Number(progress || 0)));
  const showTitle = clamped >= 2 && clamped < 65 && phase !== 'fading';
  const titleLeaving = clamped >= 60 || phase === 'fading';
  const showBrand = clamped >= 65;
  const brandProgress = Math.max(0, Math.min(100, ((clamped - 65) / 35) * 100));
  const fadeOut = phase === 'fading';

  return (
    <section className={`startup-splash ${fadeOut ? 'is-fading-out' : ''}`}>
      <div className={`startup-copy-stage ${showTitle ? 'show' : ''} ${titleLeaving ? 'leaving' : ''}`}>
        <div className="startup-copy-stack">
          <p
            className="startup-copy-line startup-copy-network"
            style={{ textTransform: 'none', fontFamily: 'Orbitron, sans-serif', fontWeight: 800 }}
          >
            Synergy Network
          </p>
          <p className="startup-copy-line startup-copy-panel" style={{ textTransform: 'none' }}>
            Node Control Panel
          </p>
        </div>
      </div>

      <div className={`startup-brand-stage ${showBrand ? 'show' : ''}`}>
        <div className="startup-logo-wrap">
          <img src={brandLogoSrc} alt="Synergy Network" className="startup-logo" />
        </div>
        <div className="startup-progress-wrap">
          <div className="startup-progress-track">
            <div className="startup-progress-fill" style={{ width: `${brandProgress}%` }} />
          </div>
          <p className="startup-progress-text">{Math.round(brandProgress)}%</p>
        </div>
      </div>
    </section>
  );
}

export default StartupLoadingScreen;
