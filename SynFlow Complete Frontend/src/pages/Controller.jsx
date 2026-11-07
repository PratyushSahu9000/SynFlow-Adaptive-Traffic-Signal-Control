import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { useExp } from '../ExperimentContext';
import Gate from '../components/Gate';
import { Panel, Facts, MetricCards, DirectionsPanel, PredictionPanel, EmergencyPanel, CountsPanel, COLORS, fmt, isNum, label, duration, tip } from '../components/Common';

const INFO = {
  fixed: { title: 'Fixed-time control', color: COLORS.fixed, blurb: 'Baseline: every approach gets the same fixed green time, whatever the traffic.' },
  nn: { title: 'Neural network (MLP)', color: COLORS.nn, blurb: 'An MLP estimates demand for each approach and picks the signal phase. Its recommendation is applied directly.' },
  nesy: { title: 'Neuro-Symbolic AI', color: COLORS.nesy, blurb: 'The MLP recommends a phase, then symbolic rules (safety, minimum/maximum green, maximum waiting, fairness, emergency priority) accept or override it.' },
};

export default function Controller({ k }) {
  const { exp } = useExp();
  const d = exp?.results?.[k];
  const { title, color, blurb } = INFO[k];
  return (
    <div className="page">
      <h1 style={{ color }}>{title}</h1>
      <p className="muted">{blurb}</p>
      <Gate>{d ? <Body k={k} d={d} color={color} /> : <p className="empty">No data found for this controller.</p>}</Gate>
    </div>
  );
}

function Body({ k, d, color }) {
  const wall = d.runtime?.wall_clock_seconds;
  return (
    <>
      <Facts items={[
        ['SUMO seed', d.sumo_seed],
        ['Simulated time', duration(d.simulation_duration_seconds)],
        ['Signal switches', d.signal ? fmt(d.signal.switches) : undefined],
        ['Run time', isNum(wall) ? `${wall.toFixed(1)} s` : undefined],
        ['Fixed green time', d.fixed_green_time !== undefined ? `${d.fixed_green_time} s` : undefined],
        ['Yellow time', d.yellow_time !== undefined ? `${d.yellow_time} s` : undefined],
        ['MLP decisions', d.mlp ? fmt(d.mlp.decisions) : undefined],
      ]} />
      <MetricCards total={d.total} color={color} />
      <DirectionsPanel directions={d.directions} color={color} />
      {k === 'nn' && <CountsPanel title="Decision log" note="Every decision is the MLP recommendation applied as-is (no symbolic layer)." counts={d.rule_counts} color={color} />}
      {k === 'nesy' && <NesyExtras d={d} color={color} />}
      {k !== 'fixed' && <PredictionPanel pred={d.last_prediction} color={color} />}
      {k !== 'fixed' && <EmergencyPanel em={d.emergency} />}
      <details className="panel"><summary>Raw JSON</summary><pre>{JSON.stringify(d, null, 2)}</pre></details>
    </>
  );
}

function NesyExtras({ d, color }) {
  const m = d.mlp || {};
  const s = d.symbolic || {};
  const examples = d.explainability?.examples || [];
  const pie = [
    { name: 'MLP accepted by rules', value: m.agreement_count },
    { name: 'Overridden by rules', value: m.disagreement_count },
  ].filter((x) => isNum(x.value));
  return (
    <>
      <Panel title="Neural network vs symbolic rules" note="Each MLP decision is checked by the rule engine, which can accept or override it.">
        <Facts items={[
          ['MLP decisions', fmt(m.decisions)],
          ['Accepted', fmt(m.agreement_count)],
          ['Overridden', fmt(s.total_overrides)],
          ['Agreement rate', isNum(m.agreement_rate) ? `${fmt(m.agreement_rate, 1)}%` : undefined],
          ['Override rate', isNum(s.override_rate) ? `${fmt(s.override_rate, 1)}%` : undefined],
        ]} />
        {pie.length > 0 && (
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={pie} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} label>
                <Cell fill={color} />
                <Cell fill="#f59e0b" />
              </Pie>
              <Tooltip {...tip} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        )}
      </Panel>
      <CountsPanel title="Why the rules overrode the MLP" note={`${fmt(s.total_overrides)} overrides in total, by rule.`} counts={s.rule_counts} color={color} />
      <CountsPanel title="Decision log by rule" counts={d.rule_counts} color={color} />
      {examples.length > 0 && (
        <Panel title="Human-readable reasoning" note={`Sample of ${examples.length} overrides (of ${fmt(s.total_overrides)}).`}>
          <div className="scroll">
            <table>
              <thead><tr><th>Time (s)</th><th>MLP recommended</th><th>Final decision</th><th>Rule</th><th>Reason</th></tr></thead>
              <tbody>
                {examples.map((e, i) => (
                  <tr key={i}>
                    <td>{fmt(e.time_seconds)}</td><td>{e.mlp_recommended}</td><td>{e.final_decision}</td>
                    <td>{label(e.rule)}</td><td className="wrap">{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}
