import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api';

const Ctx = createContext(null);
export const useExp = () => useContext(Ctx);

export function ExperimentProvider({ children }) {
  const [list, setList] = useState([]);
  const [id, setId] = useState(null);
  const [exp, setExp] = useState(null);
  const [cmp, setCmp] = useState(null);
  const [error, setError] = useState('');

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
          es.onmessage = (m) => {
            const d = JSON.parse(m.data);
            if (d.type === 'progress') return;
            es.close();
            load();
            refreshList();
          };
          es.onerror = () => es.close();
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
    try {
      const r = await api.start();
      await refreshList();
      setId(r.id);
    } catch (e) {
      setError(e.message);
    }
  };

  return <Ctx.Provider value={{ list, id, setId, exp, cmp, error, start }}>{children}</Ctx.Provider>;
}
