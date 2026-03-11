import { useState, useEffect, useRef } from 'react';
import { invoke, listen } from '../lib/desktopClient';

function LogsViewer() {
  const [logs, setLogs] = useState([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const logsEndRef = useRef(null);

  useEffect(() => {
    loadInitialLogs();
  }, []);

  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const loadInitialLogs = async () => {
    try {
      const logLines = await invoke('read_log_file', { lines: 100 });
      setLogs(logLines);
    } catch (err) {
      console.error('Failed to load logs:', err);
      setLogs(['No logs available yet. Start the node to see logs.']);
    }
  };

  const startStreaming = async () => {
    if (isStreaming) return;

    setIsStreaming(true);
    
    const unlisten = await listen('log-line', (event) => {
      setLogs(prev => [...prev, event.payload]);
    });

    try {
      await invoke('stream_logs');
    } catch (err) {
      console.error('Failed to stream logs:', err);
      unlisten();
      setIsStreaming(false);
    }
  };

  const stopStreaming = () => {
    setIsStreaming(false);
    // In a real implementation, you'd unlisten here
  };

  const clearLogs = () => {
    setLogs([]);
  };

  const refreshLogs = async () => {
    await loadInitialLogs();
  };

  return (
    <div className="logs-viewer">
      <div className="logs-header">
        <h3>Node Logs</h3>
        <div className="logs-controls">
          <label className="checkbox-label">
            <input 
              type="checkbox" 
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
          <button 
            className="btn btn-small"
            onClick={isStreaming ? stopStreaming : startStreaming}
          >
            {isStreaming ? '⏸ Pause' : '▶ Stream'}
          </button>
          <button 
            className="btn btn-small"
            onClick={refreshLogs}
          >
            ↻ Refresh
          </button>
          <button 
            className="btn btn-small btn-danger"
            onClick={clearLogs}
          >
            Clear
          </button>
        </div>
      </div>
      
      <div className="logs-container">
        <div className="logs-content">
          {logs.length === 0 ? (
            <div className="logs-empty">No logs to display</div>
          ) : (
            logs.map((log, index) => (
              <div key={index} className="log-line">
                <span className="log-number">{index + 1}</span>
                <span className="log-text">{log}</span>
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      </div>
      
      <div className="logs-footer">
        <span className="logs-count">{logs.length} lines</span>
      </div>
    </div>
  );
}

export default LogsViewer;
