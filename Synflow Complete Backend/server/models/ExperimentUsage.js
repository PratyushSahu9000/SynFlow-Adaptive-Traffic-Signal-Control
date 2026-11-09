'use strict';

const mongoose = require('mongoose');

// One document per UTC calendar day. `_id` is the day key (YYYY-MM-DD), so the
// unique index on `_id` makes the daily counter safe across processes.
const experimentUsageSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    count: { type: Number, required: true, min: 0 },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { versionKey: false, collection: 'experiment_usage' }
);

module.exports = mongoose.model('ExperimentUsage', experimentUsageSchema);
