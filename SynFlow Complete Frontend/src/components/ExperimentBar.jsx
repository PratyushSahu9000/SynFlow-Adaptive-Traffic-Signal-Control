import { useExp } from '../ExperimentContext';

export default function ExperimentBar() {
  const { list, id, setId, exp, start, error } = useExp();
  const status = exp?.status;
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
      <button className="btn" onClick={start} disabled={status === 'running'}>
        {status === 'running' ? 'Running…' : '▶ Run new experiment'}
      </button>
      {status && <span className={`badge ${status}`}>{status}</span>}
      {(error || exp?.error) && <span className="err">{error || exp.error}</span>}
    </div>
  );
}
