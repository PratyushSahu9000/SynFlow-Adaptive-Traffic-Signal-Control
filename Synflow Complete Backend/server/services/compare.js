// true = higher is better, false = lower is better
const METRICS = {
  average_waiting_time: false,
  average_queue_length: false,
  average_speed: true,
  avg_time_loss: false,
  avg_duration: false,
  throughput: true,
};

const round = (n) => Math.round(n * 100) / 100;

// % improvement over the Fixed controller (positive = better than Fixed)
function improvement(base, value, higherIsBetter) {
  if (!base) return 0;
  const change = higherIsBetter ? value - base : base - value;
  return round((change / base) * 100);
}

function compare({ fixed, nn, nesy }) {
  const out = {};
  for (const [metric, higher] of Object.entries(METRICS)) {
    const f = fixed.total[metric];
    const n = nn.total[metric];
    const s = nesy.total[metric];
    out[metric] = {
      fixed: f,
      nn: n,
      nesy: s,
      nn_vs_fixed_pct: improvement(f, n, higher),
      nesy_vs_fixed_pct: improvement(f, s, higher),
    };
  }
  return out;
}

module.exports = compare;
