import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ReferenceLine, ResponsiveContainer } from 'recharts';
import { useExp } from '../ExperimentContext';
import Gate from '../components/Gate';
import { Panel, METRIC, COLORS, NAMES, DIRS, tip, fmt, isNum, cap } from '../components/Common';

const CS = ['fixed', 'nn', 'nesy'];
const sign = (v) => (v >= 0 ? '+' : '−');

function bestOf(m, k) {
  return CS.reduce((a, b) => ((METRIC[k].higher ? m[b] > m[a] : m[b] < m[a]) ? b : a));
}

function Chip({ v }) {
  const cls = v > 0 ? 'good' : v < 0 ? 'bad' : '';
  return <span className={`chip ${cls}`}>{v > 0 ? '▲' : v < 0 ? '▼' : '='} {Math.abs(v).toFixed(1)}% {v < 0 ? 'worse' : 'better'}</span>;
}

export default function Compare() {
  const { cmp, exp } = useExp();
  return (
    <div className="page">
      <h1>Compare: Fixed vs Neural Network vs Neuro-Symbolic</h1>
      <p className="muted">
        Same SUMO traffic{exp?.seed ? ` (seed ${exp.seed})` : ''} for all three controllers. Improvement is measured against the Fixed controller.
      </p>
      <Gate>{cmp && exp?.results ? <Body cmp={cmp} r={exp.results} /> : <p className="empty">Loading comparison…</p>}</Gate>
    </div>
  );
}

function Body({ cmp, r }) {
  const keys = Object.keys(METRIC).filter((k) => cmp[k]);
  if (!keys.length) return <p className="empty">No comparable metrics found.</p>;

  const avg = (c) => keys.reduce((s, k) => s + cmp[k][`${c}_vs_fixed_pct`], 0) / keys.length;
  const wins = { fixed: 0, nn: 0, nesy: 0 };
  keys.forEach((k) => (wins[bestOf(cmp[k], k)] += 1));
  const wt = cmp.average_waiting_time;
  const pctData = keys.map((k) => ({ metric: METRIC[k].name, NN: cmp[k].nn_vs_fixed_pct, NeSy: cmp[k].nesy_vs_fixed_pct }));
  const dirData = (field) => DIRS.map((d) => ({ direction: cap(d), ...Object.fromEntries(CS.map((c) => [c, r[c]?.directions?.[d]?.[field]])) }));

  const behaviour = [
    ['Signal switches', (c) => r[c]?.signal?.switches],
    ['Run time (s)', (c) => r[c]?.runtime?.wall_clock_seconds],
    ['MLP decisions', (c) => r[c]?.mlp?.decisions],
    ['Symbolic overrides', (c) => r[c]?.symbolic?.total_overrides],
    ['Emergency blocked events', (c) => r[c]?.emergency?.event_count],
    ['Emergency blocked time (s)', (c) => r[c]?.emergency?.total_blocked_duration_seconds],
  ];

  const insights = [
    `Best controller per metric: Neural Network ${wins.nn}, Neuro-Symbolic ${wins.nesy}, Fixed ${wins.fixed} (out of ${keys.length}).`,
  ];
  if (wt) insights.push(`Average waiting time: ${fmt(wt.fixed)} s (Fixed) → ${fmt(wt.nn)} s (NN) and ${fmt(wt.nesy)} s (NeSy).`);
  const sw = CS.map((c) => r[c]?.signal?.switches);
  if (sw.every(isNum)) insights.push(`Signal switches: ${fmt(sw[0])} Fixed, ${fmt(sw[1])} NN, ${fmt(sw[2])} NeSy.`);
  const sym = r.nesy?.symbolic;
  if (sym && isNum(sym.total_overrides)) insights.push(`The symbolic rules overrode ${fmt(sym.total_overrides)} of ${fmt(r.nesy.mlp?.decisions)} MLP decisions (${fmt(sym.override_rate, 1)}%).`);

  return (
    <>
      <div className="hero-compare">
        {['nn', 'nesy'].map((c) => {
          const a = avg(c);
          return (
            <div className="kpi" key={c} style={{ borderColor: COLORS[c] }}>
              <div className="muted">{NAMES[c]} vs Fixed</div>
              <div className={`kpi-num ${a >= 0 ? 'good' : 'bad'}`}>{sign(a)}{Math.abs(a).toFixed(1)}%</div>
              <div className="muted small">average improvement across {keys.length} metrics</div>
              {wt && <div className="kpi-sub"><Chip v={wt[`${c}_vs_fixed_pct`]} /> <span className="muted small">waiting time</span></div>}
            </div>
          );
        })}
      </div>

      <Panel title="Key takeaways">
        <ul className="insights">{insights.map((t) => <li key={t}>{t}</li>)}</ul>
      </Panel>

      <Panel title="Improvement over Fixed (%)" note="Positive = better than Fixed (for “lower is better” metrics this means a reduction).">
        <ResponsiveContainer width="100%" height={340}>
          <BarChart data={pctData}>
            <CartesianGrid stroke="#1e293b" />
            <XAxis dataKey="metric" stroke="#94a3b8" interval={0} tick={{ fontSize: 12 }} />
            <YAxis stroke="#94a3b8" unit="%" />
            <Tooltip {...tip} formatter={(v) => `${Number(v).toFixed(2)}%`} />
            <Legend />
            <ReferenceLine y={0} stroke="#64748b" />
            <Bar dataKey="NN" name="Neural Network" fill={COLORS.nn} />
            <Bar dataKey="NeSy" name="Neuro-Symbolic" fill={COLORS.nesy} />
          </BarChart>
        </ResponsiveContainer>
      </Panel>

      <h2>Metric by metric</h2>
      <div className="grid">
        {keys.map((k) => {
          const m = cmp[k];
          const max = Math.max(...CS.map((c) => m[c])) || 1;
          const best = bestOf(m, k);
          return (
            <section className="panel" key={k}>
              <h3>{METRIC[k].name}</h3>
              <p className="muted small">{METRIC[k].unit} · {METRIC[k].higher ? 'higher' : 'lower'} is better</p>
              {CS.map((c) => (
                <div className="barrow" key={c}>
                  <span className="bl">{NAMES[c]}{best === c && <em> best</em>}</span>
                  <div className="track"><div className="fill" style={{ width: `${(m[c] / max) * 100}%`, background: COLORS[c] }} /></div>
                  <span className="bv">{fmt(m[c])}</span>
                </div>
              ))}
              <div className="chips">
                <span className="muted small">NN</span><Chip v={m.nn_vs_fixed_pct} />
                <span className="muted small">NeSy</span><Chip v={m.nesy_vs_fixed_pct} />
              </div>
            </section>
          );
        })}
      </div>

      <h2>By direction</h2>
      <div className="grid2">
        {[['average_queue_length', 'Average queue length'], ['throughput', 'Throughput (vehicles)']].map(([f, t]) => (
          <Panel key={f} title={t}>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={dirData(f)}>
                <CartesianGrid stroke="#1e293b" />
                <XAxis dataKey="direction" stroke="#94a3b8" />
                <YAxis stroke="#94a3b8" />
                <Tooltip {...tip} />
                <Legend />
                {CS.map((c) => <Bar key={c} dataKey={c} name={NAMES[c]} fill={COLORS[c]} />)}
              </BarChart>
            </ResponsiveContainer>
          </Panel>
        ))}
      </div>

      <Panel title="Controller behaviour">
        <div className="scroll">
          <table>
            <thead><tr><th>Measure</th>{CS.map((c) => <th key={c}>{NAMES[c]}</th>)}</tr></thead>
            <tbody>
              {behaviour.map(([n, get]) => (
                <tr key={n}><td>{n}</td>{CS.map((c) => <td key={c}>{fmt(get(c))}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="All metrics">
        <div className="scroll">
          <table>
            <thead><tr><th>Metric</th><th>Fixed</th><th>NN</th><th>NeSy</th><th>NN vs Fixed</th><th>NeSy vs Fixed</th><th>Best</th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k}>
                  <td>{METRIC[k].name} ({METRIC[k].unit})</td>
                  <td>{fmt(cmp[k].fixed)}</td><td>{fmt(cmp[k].nn)}</td><td>{fmt(cmp[k].nesy)}</td>
                  <td><Chip v={cmp[k].nn_vs_fixed_pct} /></td><td><Chip v={cmp[k].nesy_vs_fixed_pct} /></td>
                  <td style={{ color: COLORS[bestOf(cmp[k], k)] }}>{NAMES[bestOf(cmp[k], k)]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
