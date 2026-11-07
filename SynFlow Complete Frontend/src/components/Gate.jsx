import { useExp } from '../ExperimentContext';
import ExperimentRunning from './ExperimentRunning';

export default function Gate({ children }) {
  const { exp, id } = useExp();
  if (!id) return <p className="empty">No experiment yet. Click “Run new experiment” to start one.</p>;
  if (!exp) return <p className="empty">Loading…</p>;
  if (exp.status === 'running') return <ExperimentRunning experiment={exp} />;
  if (exp.status === 'failed') return <p className="empty err">Experiment failed: {exp.error}</p>;
  return children;
}
