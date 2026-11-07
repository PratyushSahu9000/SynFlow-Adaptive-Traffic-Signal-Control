import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid, ResponsiveContainer } from 'recharts';

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const label = (k) => String(k).replace(/_/g, ' ');
export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const fmt = (v, d = 2) => (isNum(v) ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(d)) : v ?? '—');
export const duration = (s) => (isNum(s) ? (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`) : undefined);

export const METRIC = {
  average_waiting_time: { name: 'Average waiting time', unit: 's', higher: false },
  average_queue_length: { name: 'Average queue length', unit: 'vehicles', higher: false },
  average_speed: { name: 'Average speed', unit: 'm/s', higher: true },
  avg_time_loss: { name: 'Average time loss', unit: 's', higher: false },
  avg_duration: { name: 'Average trip duration', unit: 's', higher: false },
  throughput: { name: 'Throughput', unit: 'vehicles', higher: true },
};
export const COLORS = { fixed: '#94a3b8', nn: '#a78bfa', nesy: '#22d3ee' };
export const NAMES = { fixed: 'Fixed', nn: 'Neural Network', nesy: 'Neuro-Symbolic' };
export const DIRS = ['north', 'south', 'east', 'west'];
export const tip = {
  contentStyle: { background: '#0f172a', border: '1px solid #1e293b', color: '#e2e8f0' },
  itemStyle: { color: '#e2e8f0' },
  labelStyle: { color: '#cbd5e1' },
  cursor: { fill: 'rgba(148,163,184,.08)' },
};

export function Panel({ title, note, children }) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      {note && <p className="muted small">{note}</p>}
      {children}
    </section>
  );
}

export function Facts({ items }) {
  return (
    <div className="facts">
      {items.filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => (
        <div key={k}><span className="muted small">{k}</span><b>{v}</b></div>
      ))}
    </div>
  );
}

export function MetricCards({ total, color }) {
  return (
    <div className="cards">
      {Object.keys(METRIC).filter((k) => isNum(total?.[k])).map((k) => (
        <div className="card" key={k} style={{ borderTopColor: color }}>
          <div className="muted">{METRIC[k].name}</div>
          <div className="big">{fmt(total[k])} <small>{METRIC[k].unit}</small></div>
          <div className="muted small">{METRIC[k].higher ? 'higher is better' : 'lower is better'}</div>
        </div>
      ))}
    </div>
  );
}

export function DirectionsPanel({ directions, color }) {
  const rows = DIRS.filter((d) => directions?.[d]).map((d) => ({ direction: cap(d), ...directions[d] }));
  if (!rows.length) return null;
  return (
    <Panel title="Traffic by direction" note="Per-approach averages over the whole simulation.">
      <div className="grid2">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={rows}>
            <CartesianGrid stroke="#1e293b" />
            <XAxis dataKey="direction" stroke="#94a3b8" />
            <YAxis stroke="#94a3b8" />
            <Tooltip {...tip} />
            <Legend />
            <Bar dataKey="average_queue_length" name="Avg queue length" fill={color} />
            <Bar dataKey="average_waiting_time" name="Avg waiting time (s)" fill="#f59e0b" />
          </BarChart>
        </ResponsiveContainer>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={rows}>
            <CartesianGrid stroke="#1e293b" />
            <XAxis dataKey="direction" stroke="#94a3b8" />
            <YAxis stroke="#94a3b8" />
            <Tooltip {...tip} />
            <Legend />
            <Bar dataKey="throughput" name="Throughput (vehicles)" fill={color} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="scroll">
        <table>
          <thead><tr><th>Direction</th><th>Avg waiting time (s)</th><th>Avg queue length</th><th>Throughput</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.direction}>
                <td>{r.direction}</td><td>{fmt(r.average_waiting_time)}</td><td>{fmt(r.average_queue_length)}</td><td>{fmt(r.throughput)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function PredictionPanel({ pred, color }) {
  const rows = DIRS.filter((d) => isNum(pred?.[d])).map((d) => ({ direction: cap(d), score: pred[d] }));
  if (!rows.length) return null;
  return (
    <Panel title="MLP demand scores (last decision)" note="Higher score = the MLP sees more demand / priority on that approach.">
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={rows}>
          <CartesianGrid stroke="#1e293b" />
          <XAxis dataKey="direction" stroke="#94a3b8" />
          <YAxis stroke="#94a3b8" />
          <Tooltip {...tip} />
          <Bar dataKey="score" name="Demand score" fill={color} />
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}

export function EmergencyPanel({ em }) {
  if (!em) return null;
  const list = (o) => Object.entries(o || {}).map(([k, v]) => `${k} ×${v}`).join(', ') || 'none';
  return (
    <Panel title="Emergency vehicles">
      <Facts items={[
        ['Blocked events', fmt(em.event_count)],
        ['Total blocked time', `${fmt(em.total_blocked_duration_seconds)} s`],
        ['Average blocked time', `${fmt(em.average_blocked_duration_seconds)} s`],
        ['By type', list(em.events_by_emergency_type)],
        ['By approach', list(em.events_by_approach)],
      ]} />
      {em.definition && <p className="muted small">{em.definition}</p>}
    </Panel>
  );
}

export function CountsPanel({ title, note, counts, color }) {
  const rows = Object.entries(counts || {}).map(([k, v]) => ({ name: label(k), value: v }));
  if (!rows.length) return null;
  return (
    <Panel title={title} note={note}>
      <ResponsiveContainer width="100%" height={Math.max(160, rows.length * 38)}>
        <BarChart data={rows} layout="vertical" margin={{ left: 20 }}>
          <CartesianGrid stroke="#1e293b" horizontal={false} />
          <XAxis type="number" stroke="#94a3b8" allowDecimals={false} />
          <YAxis type="category" dataKey="name" stroke="#94a3b8" width={180} />
          <Tooltip {...tip} />
          <Bar dataKey="value" name="Count" fill={color} />
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}
