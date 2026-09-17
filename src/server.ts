import http from 'http';
import { app } from './app';
import { setupWebSocketGateway } from './ws';
import dotenv from 'dotenv';

// Load environment variables for standalone execution
dotenv.config();

const PORT = Number(process.env.BACKEND_PORT || 3001);

/**
 * Standalone Backend Entry Point
 * Use this file to run the server entirely separately from the React frontend.
 * Run using: `npx tsx server/server.ts`
 */
async function startStandaloneServer() {
  const server = http.createServer(app);
  
  // Setup WebSocket Gateway at /ws
  setupWebSocketGateway(server);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[HighLyAgent] Backend API on http://0.0.0.0:${PORT}  paths: /v1  /api/v1  /ws`);
  });
}

startStandaloneServer().catch((err) => {
  console.error('[HighLyAgent] Fatal error starting standalone server:', err);
  process.exit(1);
});
