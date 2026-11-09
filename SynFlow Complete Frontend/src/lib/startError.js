// Pure helpers for turning an API failure into a friendly, public message.
// Kept free of React and fetch so it can be unit tested directly.

function duration(seconds) {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;

  const minutes = Math.ceil(s / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.ceil(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

function resetLabel(resetAt) {
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return 'midnight UTC';
  return date.toLocaleString();
}

export function describeStartError(error = {}) {
  const status = Number(error.status) || 0;
  const body = error.body && typeof error.body === 'object' ? error.body : {};
  const retry = Number(error.retryAfterSeconds ?? body.retryAfterSeconds);

  if (status === 409) {
    return {
      message: 'Another SynFlow demonstration is currently running. Please try again shortly.',
    };
  }

  if (status === 429) {
    // Global daily capacity rejects with a reset timestamp; per-IP limits
    // reject with a retry delay.
    if (body.resetAt || (body.limit && !body.retryAfterSeconds)) {
      return {
        message: "Today's public experiment capacity has been reached. Please come back tomorrow.",
        detail: `Capacity resets at ${resetLabel(body.resetAt)}.`,
      };
    }

    return {
      message: 'You have reached the experiment start limit for now.',
      detail:
        Number.isFinite(retry) && retry > 0
          ? `Please try again in ${duration(retry)}.`
          : 'Please try again later.',
    };
  }

  if (status === 503) {
    return {
      message: 'Experiments are temporarily unavailable. Please try again later.',
    };
  }

  if (status === 0) {
    return {
      message: 'Could not reach the SynFlow server. Check your connection and try again.',
    };
  }

  return {
    message: 'Could not start the experiment. Please try again later.',
  };
}
