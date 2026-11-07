const mongoose = require('mongoose');

const experimentSchema = new mongoose.Schema(
  {
    seed: { type: Number },
    status: { type: String, enum: ['running', 'completed', 'failed'], default: 'running' },
    results: {
      fixed: mongoose.Schema.Types.Mixed,
      nn: mongoose.Schema.Types.Mixed,
      nesy: mongoose.Schema.Types.Mixed,
    },
    error: String,
    finishedAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model('Experiment', experimentSchema);
