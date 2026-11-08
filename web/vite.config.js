import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the API runs on PORT (default 7802, npm start) and Vite on VITE_PORT (default 7803, dev only). /api and /webhook are proxied, so the browser only ever
// talks to one origin (same-origin writes). 7803 is a dev-only default; Vite moves to a free port if it is busy.
const api = { target: `http://127.0.0.1:${Number(process.env.PORT) || 7802}` };

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: Number(process.env.VITE_PORT) || 7803, strictPort: false, proxy: { "/api": api, "/webhook": api } },
  test: { environment: "jsdom", globals: true, setupFiles: "./src/testSetup.js" },
});
