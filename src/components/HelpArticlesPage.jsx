import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getVersion, invoke } from '../lib/desktopClient';

function extractText(children) {
  if (children === null || children === undefined) return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractText).join('');
  if (typeof children === 'object' && 'props' in children) {
    return extractText(children.props?.children);
  }
  return '';
}

function slugifyHeading(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function HelpArticlesPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [manualMarkdown, setManualMarkdown] = useState('');
  const [appVersion, setAppVersion] = useState('');

  const manualSections = useMemo(
    () =>
      String(manualMarkdown || '')
        .split('\n')
        .filter((line) => /^##\s+/.test(line))
        .map((line) => {
          const label = line.replace(/^##\s+/, '').trim();
          return {
            label,
            id: slugifyHeading(label),
          };
        }),
    [manualMarkdown],
  );

  const markdownComponents = useMemo(
    () => ({
      a: ({ href, children, ...props }) => {
        const isExternal = /^https?:\/\//i.test(String(href || ''));
        return (
          <a
            href={href}
            {...props}
            target={isExternal ? '_blank' : undefined}
            rel={isExternal ? 'noreferrer' : undefined}
          >
            {children}
          </a>
        );
      },
      h1: ({ children, ...props }) => {
        const id = slugifyHeading(extractText(children));
        return (
          <h1 id={id} {...props}>
            {children}
          </h1>
        );
      },
      h2: ({ children, ...props }) => {
        const id = slugifyHeading(extractText(children));
        return (
          <h2 id={id} {...props}>
            {children}
          </h2>
        );
      },
      h3: ({ children, ...props }) => {
        const id = slugifyHeading(extractText(children));
        return (
          <h3 id={id} {...props}>
            {children}
          </h3>
        );
      },
      h4: ({ children, ...props }) => {
        const id = slugifyHeading(extractText(children));
        return (
          <h4 id={id} {...props}>
            {children}
          </h4>
        );
      },
    }),
    [],
  );

  const loadManual = async () => {
    setLoading(true);
    setError('');
    try {
      await invoke('monitor_initialize_workspace');
      const [resolvedWorkspacePath, markdown] = await Promise.all([
        invoke('get_monitor_workspace_path'),
        invoke('get_monitor_user_manual_markdown'),
      ]);
      setWorkspacePath(String(resolvedWorkspacePath || ''));
      setManualMarkdown(String(markdown || ''));
    } catch (err) {
      console.error('Failed to load user manual in Help window:', err);
      setError(String(err));
      setManualMarkdown('');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadManual();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadVersion = async () => {
      try {
        const version = await getVersion();
        if (!cancelled) {
          setAppVersion(String(version || ''));
        }
      } catch {
        if (!cancelled) {
          setAppVersion('');
        }
      }
    };

    loadVersion();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="monitor-shell help-shell">
      <div className="help-hero">
        <div>
          <p className="help-eyebrow">Synergy Node Operator Manual</p>
          <h2>Synergy Node Control Panel Help Center</h2>
          <p className="help-hero-copy">
            This view renders the bundled operator manual directly from the current workspace, so
            Help stays aligned with the shipped topology, control actions, and release/update flow.
          </p>
          <div className="help-hero-meta">
            {appVersion ? (
              <span className="help-meta-pill">
                App
                {' '}
                {appVersion}
              </span>
            ) : null}
            {workspacePath ? (
              <span className="help-meta-pill">
                Workspace
                {' '}
                <code>{workspacePath}</code>
              </span>
            ) : null}
            <span className="help-meta-pill">
              Manual
              {' '}
              <code>guides/SYNERGY_TESTNET_BETA_CONTROL_PANEL_USER_MANUAL.md</code>
            </span>
          </div>
        </div>
        <div className="help-hero-actions">
          <Link className="monitor-link-btn" to="/">
            Open Dashboard
          </Link>
          <a
            className="monitor-link-btn"
            href="https://testbeta-explorer.synergy-network.io"
            target="_blank"
            rel="noreferrer"
          >
            Open Atlas
          </a>
          <button className="monitor-btn" onClick={loadManual} disabled={loading}>
            {loading ? 'Loading...' : 'Reload Manual'}
          </button>
        </div>
      </div>

      <div className="help-brief-grid">
        <article className="help-brief-card">
          <span className="help-brief-label">Bootstrap Sequence</span>
          <strong className="help-brief-title">Machine access is external to the panel</strong>
          <p>
            The control panel assumes machine access is already in place. Use bindings,
            {' '}
            <code>status</code>
            {' '}
            and RPC checks to validate the fleet instead of trying to manage network overlays here.
          </p>
        </article>
        <article className="help-brief-card">
          <span className="help-brief-label">Binding Model</span>
          <strong className="help-brief-title">Node slots vs physical machines</strong>
          <p>
            Node detail pages operate on logical
            {' '}
            <code>node-##</code>
            {' '}
            slots. Inventory rows also show the backing physical
            {' '}
            <code>machine-##</code>
            {' '}
            host for each slot.
          </p>
        </article>
        <article className="help-brief-card">
          <span className="help-brief-label">Updates</span>
          <strong className="help-brief-title">Signed release metadata required</strong>
          <p>
            Installed apps poll the published
            {' '}
            <code>latest.json</code>
            {' '}
            release metadata. When a newer signed build exists, the header shows an install action.
          </p>
        </article>
      </div>

      {manualSections.length > 0 ? (
        <div className="help-section-nav">
          {manualSections.map((section) => (
            <a key={section.id} className="help-section-chip" href={`#${section.id}`}>
              {section.label}
            </a>
          ))}
        </div>
      ) : null}

      {loading ? (
        <div className="loading-container">
          <div className="spinner"></div>
          <p>Loading user manual...</p>
        </div>
      ) : null}

      {error ? (
        <div className="monitor-error-box">
          <strong>Failed to load manual:</strong>
          {' '}
          {error}
        </div>
      ) : null}

      {!loading && !error ? (
        <article className="help-article help-manual">
          <div className="help-source-note">
            Source:
            {' '}
            <code>{workspacePath}/guides/SYNERGY_TESTNET_BETA_CONTROL_PANEL_USER_MANUAL.md</code>
          </div>
          <div className="help-markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {manualMarkdown}
            </ReactMarkdown>
          </div>
        </article>
      ) : null}
    </section>
  );
}

export default HelpArticlesPage;
