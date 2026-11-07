# SynFlow Frontend (matches "Synflow Complete Backend")

1. Backend: `cd "Synflow Complete Backend/server" && npm install && npm start` (port 5000, needs MongoDB + Python/SUMO engine).
2. Frontend: `npm install` then `npm run dev` -> http://localhost:5173
3. Demo video: change `VIDEO_URL` at the top of `src/pages/Landing.jsx` (it is its own section, not a background).
4. Backend elsewhere? Create `.env` with `VITE_API_URL=http://host:port/api`.

Pages: `/` landing, `/fixed`, `/nn`, `/nesy`, `/compare`.
