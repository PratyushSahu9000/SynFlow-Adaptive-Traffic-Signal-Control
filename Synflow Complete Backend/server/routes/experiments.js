const express = require('express');
const Experiment = require('../models/Experiment');
const compare = require('../services/compare');
const { startExperiment, events } = require('../services/runner');

const router = express.Router();

// Start a new experiment (new seed, same seed for Fixed, NN and NeSy)
router.post('/', async (req, res) => {
  const exp = await startExperiment();
  res.status(201).json({ id: exp._id, seed: exp.seed, status: exp.status });
});

// List experiments (without the heavy results)
router.get('/', async (req, res) => {
  const list = await Experiment.find().select('-results').sort({ createdAt: -1 });
  res.json(list);
});

// One experiment with all three controllers' results (Fixed, NN, NeSy screens)
router.get('/:id', async (req, res) => {
  const exp = await Experiment.findById(req.params.id);
  if (!exp) return res.status(404).json({ error: 'Experiment not found' });
  res.json(exp);
});

// Comparison screen data
router.get('/:id/compare', async (req, res) => {
  const exp = await Experiment.findById(req.params.id);
  if (!exp) return res.status(404).json({ error: 'Experiment not found' });
  if (exp.status !== 'completed') return res.status(409).json({ error: `Experiment is ${exp.status}` });
  res.json({ seed: exp.seed, metrics: compare(exp.results) });
});

// Live progress (Server-Sent Events)
router.get('/:id/stream', async (req, res) => {
  const exp = await Experiment.findById(req.params.id).select('status error');
  if (!exp) return res.status(404).json({ error: 'Experiment not found' });

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  if (exp.status !== 'running') {
    send({ type: exp.status, error: exp.error });
    return res.end();
  }

  const id = String(exp._id);
  const onEvent = (data) => {
    send(data);
    if (data.type !== 'progress') res.end();
  };
  events.on(id, onEvent);
  req.on('close', () => events.off(id, onEvent));
});

module.exports = router;
