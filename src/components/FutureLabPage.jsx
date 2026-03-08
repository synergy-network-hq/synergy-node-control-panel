import '../styles/future-lab.css';

function FutureLabPage({
  eyebrow,
  title,
  subtitle,
  statusLabel,
  intro,
  capabilities,
  futureNote,
  accent = 'cyan',
}) {
  return (
    <section className={`future-lab-shell future-lab-shell-${accent}`}>
      <div className="future-lab-toolbar">
        <div className="future-lab-toolbar-copy">
          <p className="future-lab-eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
          <p className="future-lab-subtitle">{subtitle}</p>
        </div>
        <span className={`future-lab-status future-lab-status-${accent}`}>{statusLabel}</span>
      </div>

      <div className="future-lab-hero">
        <div className="future-lab-grid">
          <article className="future-lab-panel future-lab-panel-primary">
            <div className="future-lab-icon" aria-hidden="true">
              {accent === 'red' ? (
                <svg width="58" height="58" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
                  <path d="M8 12h8" />
                  <path d="M12 8v8" />
                </svg>
              ) : (
                <svg width="58" height="58" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M5 12h14" />
                  <path d="M12 5v14" />
                  <path d="M7 7l10 10" />
                  <path d="M17 7L7 17" />
                </svg>
              )}
            </div>
            <h3>Coming Soon</h3>
            <p>{intro}</p>
            <p className="future-lab-note">{futureNote}</p>
          </article>

          <article className="future-lab-panel">
            <p className="future-lab-kicker">Planned Surface</p>
            <h3>What This Area Is For</h3>
            <div className="future-lab-list">
              {capabilities.map((capability) => (
                <div key={capability.title} className="future-lab-list-item">
                  <strong>{capability.title}</strong>
                  <p>{capability.description}</p>
                </div>
              ))}
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

export default FutureLabPage;
