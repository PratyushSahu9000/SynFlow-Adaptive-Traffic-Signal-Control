import { useExp } from '../ExperimentContext';

export default function ExperimentBar() {
  const { list, id, setId, exp, start, error, starting, startNotice } = useExp();
  const status = exp?.status;
  const running = status === 'running';
  const busy = running || starting;

  return (
    <div className="bar">
      <select value={id || ''} onChange={(e) => setId(e.target.value)} disabled={!list.length}>
        {!list.length && <option value="">No experiments yet</option>}
        {list.map((x) => (
          <option key={x._id} value={x._id}>
            Seed {x.seed ?? 'pending'} · {x.status} · {new Date(x.createdAt).toLocaleString()}
          </option>
        ))}
      </select>
      <button
        className="btn"
        onClick={start}
        disabled={busy}
        aria-busy={starting}
        title={running ? 'A SynFlow experiment is already running' : undefined}
      >
        {starting ? 'Starting…' : running ? 'Running…' : '▶ Run new experiment'}
      </button>
      {status && <span className={`badge ${status}`}>{status}</span>}
      {(error || exp?.error) && <span className="err">{error || exp.error}</span>}
      {startNotice && (
        <span className="notice" role="status" aria-live="polite">
          <span className="err">{startNotice.message}</span>
          {startNotice.detail && <span className="muted"> {startNotice.detail}</span>}
        </span>
      )}
    </div>
  );
}
