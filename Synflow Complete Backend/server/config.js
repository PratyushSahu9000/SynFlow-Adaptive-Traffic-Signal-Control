'use strict';

// =============================================================================
// SynFlow backend configuration
// All values are non-secret. Secrets (MONGO_URI) are read directly from the
// environment by server.js and are never logged or serialized here.
// =============================================================================

function readInt(env, name, defaultValue, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return defaultValue;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid configuration for ${name}`);
  }
  return value;
}

function loadConfig(env = process.env) {
  return {
    nodeEnv: env.NODE_ENV || 'development',
    isProduction: env.NODE_ENV === 'production',
    host: '0.0.0.0',
    port: readInt(env, 'PORT', 10000, { min: 1, max: 65535 }),

    // Render terminates TLS and forwards the client address through one proxy.
    // Do not use `true` here: trusting every proxy lets clients spoof their IP.
    trustProxyHops: readInt(env, 'TRUST_PROXY_HOPS', 1, { min: 0, max: 10 }),

    api: {
      windowMs: readInt(env, 'API_RATE_LIMIT_WINDOW_MS', 900000, { min: 1000 }),
      max: readInt(env, 'API_RATE_LIMIT_MAX', 120, { min: 1 }),
    },

    experiments: {
      cooldownWindowMs: readInt(env, 'EXPERIMENT_IP_WINDOW_MS', 120000, { min: 1000 }),
      cooldownMax: readInt(env, 'EXPERIMENT_IP_MAX', 1, { min: 0 }),
      hourlyWindowMs: readInt(env, 'EXPERIMENT_IP_HOURLY_WINDOW_MS', 3600000, { min: 1000 }),
      hourlyMax: readInt(env, 'EXPERIMENT_IP_HOURLY_MAX', 5, { min: 0 }),
      dailyWindowMs: readInt(env, 'EXPERIMENT_IP_DAILY_WINDOW_MS', 86400000, { min: 1000 }),
      dailyMax: readInt(env, 'EXPERIMENT_IP_DAILY_MAX', 10, { min: 0 }),
      globalDailyLimit: readInt(env, 'GLOBAL_DAILY_EXPERIMENT_LIMIT', 25, { min: 0 }),
      maxConcurrent: readInt(env, 'MAX_CONCURRENT_EXPERIMENTS', 1, { min: 1, max: 10 }),
      timeoutMs: readInt(env, 'EXPERIMENT_TIMEOUT_MS', 1200000, { min: 100 }),
    },

    sse: {
      maxPerIp: readInt(env, 'SSE_MAX_PER_IP', 2, { min: 1 }),
      maxTotal: readInt(env, 'SSE_MAX_TOTAL', 50, { min: 1 }),
      heartbeatMs: readInt(env, 'SSE_HEARTBEAT_MS', 15000, { min: 1000 }),
    },
  };
}

const config = loadConfig();

module.exports = { config, loadConfig };
