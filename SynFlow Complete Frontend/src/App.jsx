import { Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { ExperimentProvider } from './ExperimentContext';
import ExperimentBar from './components/ExperimentBar';
import Landing from './pages/Landing';
import Controller from './pages/Controller';
import Compare from './pages/Compare';

const LINKS = [
  ['/', 'Home'],
  ['/fixed', 'Fixed Traffic'],
  ['/nn', 'Neural Network'],
  ['/nesy', 'Neuro-Symbolic AI'],
  ['/compare', 'Compare'],
];

export default function App() {
  const { pathname } = useLocation();
  return (
    <ExperimentProvider>
      <header className="nav">
        <NavLink to="/" className="logo">SynFlow</NavLink>
        <nav>
          {LINKS.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
              {label}
            </NavLink>
          ))}
        </nav>
      </header>
      {pathname !== '/' && <ExperimentBar />}
      <main>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/fixed" element={<Controller k="fixed" />} />
          <Route path="/nn" element={<Controller k="nn" />} />
          <Route path="/nesy" element={<Controller k="nesy" />} />
          <Route path="/compare" element={<Compare />} />
        </Routes>
      </main>
    </ExperimentProvider>
  );
}
