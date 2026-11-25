import { defineConfig } from 'vite';

// /api is proxied to the traffic-AI backend (npm run backend) so the Groq key never reaches the browser.
export default defineConfig({ server: { proxy: { '/api': { target: 'http://localhost:8787', ws: true } } } });
