require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');

const Experiment = require('./models/Experiment');
const { config } = require('./config');
const { runner } = require('./services/runner');
const experimentsRouter = require('./routes/experiments');

function redact(value) {
  return String(value || '')
    .replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, '[redacted-mongodb-uri]')
    .replace(/password=[^&\s"']+/gi, 'password=[redacted]');
}

const app = express();
app.disable('x-powered-by');

// Render terminates TLS in front of the container. A numeric hop count trusts
// exactly that proxy and prevents clients from spoofing X-Forwarded-For.
app.set('trust proxy', config.trustProxyHops);

// The API only serves JSON and SSE, so a restrictive HTML CSP is unnecessary;
// the remaining Helmet defaults still remove identifying and unsafe headers.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
  })
);

// CORS: explicit frontend origin(s) in production, localhost in development.
const configuredOrigins = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const devOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const allowedOrigins = new Set([
  ...configuredOrigins,
  ...(config.isProduction ? [] : devOrigins),
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

app.use('/api/experiments', experimentsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Central error handler: never expose stack traces, URIs, child-process
// stderr, filesystem paths, or database details.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (!err) return res.status(500).json({ error: 'Internal server error' });

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (err.name === 'CastError') {
    return res.status(400).json({ error: 'Invalid experiment id' });
  }

  const status = Number(err.status) || 500;
  if (status >= 500) {
    console.error('Request failed:', err.name || 'Error');
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.status(status).json({
    error: typeof err.publicMessage === 'string' ? err.publicMessage : 'Request could not be processed',
  });
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

  const server = app.listen(config.port, config.host, () => {
    console.log(`SynFlow backend listening on ${config.host}:${config.port}`);
  });

  // Long-lived SSE responses must not be cut off by the server timeout.
  server.requestTimeout = 0;

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down`);

    // Close progress streams first so server.close() is not held open.
    try {
      experimentsRouter.sse.closeAll();
    } catch {
      // Registry may already be empty.
    }

    // Kill the Python/SUMO process tree before closing the database.
    await runner.shutdown().catch(() => {});

    const force = setTimeout(() => process.exit(1), 15000);
    if (typeof force.unref === 'function') force.unref();

    server.close(() => {
      mongoose.connection
        .close(false)
        .catch(() => {})
        .finally(() => process.exit(0));
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Startup failed:', redact(err && err.message));
    process.exit(1);
  });
}

module.exports = { app, start };
