import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function HelpArticlesPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [manualMarkdown, setManualMarkdown] = useState('');

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

  return (
    <section className="monitor-shell help-shell">
      <div className="help-hero">
        <div>
          <p className="help-eyebrow">Synergy Devnet Operator Manual</p>
          <h2>Synergy Devnet Control Panel Help Center</h2>
          <p className="help-hero-copy">
            This view is rendered directly from the bundled
            {' '}
            <code>SYNERGY_DEVNET_CONTROL_PANEL_USER_MANUAL.md</code>
            {' '}
            so the Help window stays aligned with the current manual.
          </p>
          {workspacePath ? (
            <p className="help-hero-copy">
              Workspace:
              {' '}
              <code>{workspacePath}</code>
            </p>
          ) : null}
        </div>
        <div className="help-hero-actions">
          <Link className="monitor-link-btn" to="/">
            Open Dashboard
          </Link>
          <a
            className="monitor-link-btn"
            href="https://devnet-explorer.synergy-network.io"
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
            <code>{workspacePath}/guides/SYNERGY_DEVNET_CONTROL_PANEL_USER_MANUAL.md</code>
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
