import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api';
import { describeStartError } from './lib/startError';

const Ctx = createContext(null);
export const useExp = () => useContext(Ctx);

export function ExperimentProvider({ children }) {
  const [list, setList] = useState([]);
  const [id, setId] = useState(null);
  const [exp, setExp] = useState(null);
  const [cmp, setCmp] = useState(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [startNotice, setStartNotice] = useState(null);

  const refreshList = useCallback(async () => {
    try {
      const l = await api.list();
      setList(l);
      return l;
    } catch (e) {
      setError(e.message);
      return [];
    }
  }, []);

  // pick the newest experiment on first load
  useEffect(() => {
    refreshList().then((l) => {
      if (l.length) setId((cur) => cur || l[0]._id);
    });
  }, [refreshList]);

  // load the selected experiment (+ live progress while it runs)
  useEffect(() => {
    if (!id) return;
    let es;
    let cancelled = false;
    setExp(null);
    setCmp(null);
    setError('');

    const load = async () => {
      try {
        const e = await api.get(id);
        if (cancelled) return;
        setExp(e);
        if (e.status === 'completed') {
          const c = await api.compare(id);
          if (!cancelled) setCmp(c.metrics);
        }
        if (e.status === 'running') {
          es = new EventSource(api.streamUrl(id));
          let sseErrors = 0;
          es.onmessage = (m) => {
            sseErrors = 0;
            const d = JSON.parse(m.data);
            if (d.type === 'progress') return;
            es.close();
            load();
            refreshList();
          };
          // EventSource reconnects automatically. Stop only after repeated
          // failures so a transient network drop recovers without polling.
          es.onerror = () => {
            sseErrors += 1;
            if (sseErrors >= 5) es.close();
          };
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    };
    load();
    return () => {
      cancelled = true;
      if (es) es.close();
    };
  }, [id, refreshList]);

  const start = async () => {
    if (starting) return;
    setStarting(true);
    setStartNotice(null);

    try {
      const r = await api.start();
      await refreshList();
      setId(r.id);
      setError('');
    } catch (e) {
      // 409/429/503 are shown as a friendly notice. No automatic retry.
      setStartNotice(describeStartError(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Ctx.Provider
      value={{ list, id, setId, exp, cmp, error, start, starting, startNotice }}
    >
      {children}
    </Ctx.Provider>
  );
}
