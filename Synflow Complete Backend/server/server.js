require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const Experiment = require('./models/Experiment');

const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0';

// Redact anything that could resemble a connection string before logging.
function redact(value) {
  return String(value || '')
    .replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, '[redacted-mongodb-uri]')
    .replace(/password=[^&\s"']+/gi, 'password=[redacted]');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// CORS: explicit frontend origin(s) in production, localhost in development.
const configuredOrigins = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const devOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const allowedOrigins = new Set([
  ...configuredOrigins,
  ...(process.env.NODE_ENV === 'production' ? [] : devOrigins),
]);

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin/server-to-server requests have no Origin header.
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      return callback(null, false);
    },
  })
);

app.use(express.json({ limit: '32kb' }));

// Liveness: does not touch MongoDB, exposes no configuration.
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', service: 'synflow-backend' });
});

// Readiness: reports MongoDB connectivity state only, never details.
app.get('/readyz', (_req, res) => {
  const ready = mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
});

app.use('/api/experiments', require('./routes/experiments'));

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Central error handler: never expose stack traces, URIs, or internals.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && err.name === 'CastError') {
    return res.status(400).json({ error: 'Invalid experiment id' });
  }

  const status = Number(err && err.status) || 500;
  if (status >= 500) {
    console.error('Request failed:', err && err.name ? err.name : 'Error');
  }

  return res
    .status(status)
    .json({ error: status >= 500 ? 'Internal server error' : err.message });
});

async function start() {
  const mongoUri = process.env.MONGO_URI;

  if (!mongoUri) {
    console.error('Missing required environment variable: MONGO_URI');
    process.exit(1);
  }

  try {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 15000 });
  } catch (err) {
    console.error('MongoDB connection failed:', redact(err && err.message));
    process.exit(1);
  }

  console.log('MongoDB connected');

  // A run interrupted by a restart can never finish.
  await Experiment.updateMany(
    { status: 'running' },
    { status: 'failed', error: 'Server restarted during run' }
  );

  const server = app.listen(PORT, HOST, () => {
    console.log(`SynFlow backend listening on ${HOST}:${PORT}`);
  });

  // Long-lived SSE responses must not be cut off by the server timeout.
  server.requestTimeout = 0;

  const shutdown = (signal) => {
    console.log(`Received ${signal}, shutting down`);
    server.close(() => {
      mongoose.connection
        .close(false)
        .catch(() => {})
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('Startup failed:', redact(err && err.message));
  process.exit(1);
});
