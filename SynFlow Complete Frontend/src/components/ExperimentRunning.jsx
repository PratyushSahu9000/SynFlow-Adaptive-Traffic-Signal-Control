import { useEffect, useState } from 'react';
import DotMatrixVortex from './DotMatrixVortex';

const CONTROLLERS = [
  ['fixed', 'Fixed-time', 'A consistent baseline'],
  ['nn', 'Neural network', 'Adaptive signal decisions'],
  ['nesy', 'Neuro-symbolic AI', 'Adaptive decisions with safety rules'],
];

function elapsedTime(startedAt, now) {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export default function ExperimentRunning({ experiment }) {
  const [now, setNow] = useState(Date.now());
  const elapsed = elapsedTime(experiment.createdAt, now);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section className="run-wait" aria-live="polite" aria-busy="true">
      <div className="run-wait__topline">
        <span className="run-wait__live"><span /> Experiment in progress</span>
        {elapsed !== null && (
          <span className="run-wait__elapsed">
            <span className="run-wait__clock" aria-hidden="true">◷</span>
            {elapsed} elapsed
          </span>
        )}
      </div>

      <div className="run-wait__intro">
        <DotMatrixVortex />
        <div>
          <p className="run-wait__eyebrow">Matched traffic simulation</p>
          <h2>Your experiment is underway</h2>
          <p className="muted">
            We’re evaluating three signal controllers on the same traffic. Your results and comparison will appear here automatically when the run is complete.
          </p>
        </div>
      </div>

      <div className="run-wait__progress" role="progressbar" aria-label="Experiment running">
        <span />
      </div>

      <div className="run-wait__controllers">
        {CONTROLLERS.map(([key, name, description], index) => (
          <div className={`run-wait__controller run-wait__controller--${key}`} key={key}>
            <span className="run-wait__controller-number">0{index + 1}</span>
            <span className="run-wait__controller-copy">
              <strong>{name}</strong>
              <span>{description}</span>
            </span>
            <span className="run-wait__controller-indicator" aria-hidden="true" />
          </div>
        ))}
      </div>

      <p className="run-wait__footnote">
        You can keep exploring the app while this runs. The selected experiment updates as soon as it finishes.
      </p>
    </section>
  );
}
