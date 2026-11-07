require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const Experiment = require('./models/Experiment');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api/experiments', require('./routes/experiments'));

app.use((err, req, res, next) => {
  res.status(err.name === 'CastError' ? 400 : 500).json({ error: err.message });
});

mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    // a run cut off by a server restart can never finish
    await Experiment.updateMany(
      { status: 'running' },
      { status: 'failed', error: 'Server restarted during run' }
    );
    app.listen(process.env.PORT || 5000, () => console.log('SynFlow backend running'));
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
