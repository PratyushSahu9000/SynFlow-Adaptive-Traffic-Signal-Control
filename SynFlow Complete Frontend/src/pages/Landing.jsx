import { Link } from 'react-router-dom';
import { useExp } from '../ExperimentContext';
import { COLORS, NAMES, METRIC } from '../components/Common';
import demoVideoUrl from '../../video/WhatsApp Video 2026-10-12 at 2.26.15 PM.mp4';

const CARDS = [
  ['fixed', 'Every approach waits the same fixed time, even when one lane is packed and another is empty.', '/fixed'],
  ['nn', 'An MLP reads queues and waiting times, estimates demand, and gives more green to the busy lane.', '/nn'],
  ['nesy', 'The same MLP plus explicit rules for safety, minimum/maximum green, fairness, maximum waiting and emergency vehicles.', '/nesy'],
];

const STEPS = [
  ['1', 'Simulate', 'SUMO generates the same traffic for all three controllers.'],
  ['2', 'Decide', 'Fixed timer, neural network and neuro-symbolic controller each run the intersection.'],
  ['3', 'Measure', 'Waiting time, queue length, speed, time loss, trip duration and throughput are recorded.'],
  ['4', 'Compare', 'See all three side by side, with the percentage improvement over fixed-time control.'],
];

export default function Landing() {
  const { cmp } = useExp();
  const wt = cmp?.average_waiting_time;
  const keys = cmp ? Object.keys(METRIC).filter((k) => cmp[k]) : [];
  const avg = (c) => keys.reduce((s, k) => s + cmp[k][`${c}_vs_fixed_pct`], 0) / (keys.length || 1);

  return (
    <>
      <section className="hero-grad">
        <h1>Smarter signals.<br />Shorter waits.</h1>
        <p>Adaptive traffic signal control using neuro-symbolic AI: fast, safe and explainable.</p>
        <div className="row">
          <Link to="/compare" className="btn">View comparison</Link>
          <Link to="/fixed" className="btn ghost">Explore the data</Link>
        </div>
        {wt && (
          <div className="strip">
            <div><span className="muted small">Latest run · waiting time, NN vs Fixed</span><b className={wt.nn_vs_fixed_pct >= 0 ? 'good' : 'bad'}>{wt.nn_vs_fixed_pct.toFixed(1)}%</b></div>
            <div><span className="muted small">Latest run · waiting time, NeSy vs Fixed</span><b className={wt.nesy_vs_fixed_pct >= 0 ? 'good' : 'bad'}>{wt.nesy_vs_fixed_pct.toFixed(1)}%</b></div>
            <div><span className="muted small">NeSy average improvement</span><b className={avg('nesy') >= 0 ? 'good' : 'bad'}>{avg('nesy').toFixed(1)}%</b></div>
          </div>
        )}
      </section>

      <div className="page">
        <h2>See it in action</h2>
        <div className="video-box">
          <video
            src={demoVideoUrl}
            autoPlay
            loop
            muted
            playsInline
            controls
            preload="metadata"
          >
            Your browser does not support HTML video.
          </video>
        </div>

        <h2>Three ways to run one intersection</h2>
        <div className="grid">
          {CARDS.map(([c, d, to]) => (
            <Link key={c} to={to} className="card link" style={{ borderTopColor: COLORS[c] }}>
              <h3 style={{ color: COLORS[c] }}>{NAMES[c]}</h3>
              <p className="muted">{d}</p>
              <span>Open →</span>
            </Link>
          ))}
        </div>

        <h2>How it works</h2>
        <div className="grid">
          {STEPS.map(([n, t, d]) => (
            <div className="card" key={n}>
              <div className="big">{n}</div>
              <h3>{t}</h3>
              <p className="muted">{d}</p>
            </div>
          ))}
        </div>
      </div>
      <footer>SynFlow · Built with SUMO, MLP and symbolic rules</footer>
    </>
  );
}
