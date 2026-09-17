import express from 'express';
import cors from 'cors';
import { apiRouter } from './routes';
import { openApiSpec } from './docs';
import { getPgPool } from './db';
import { store } from './state';

/**
 * Global Process Crash Shield
 * Catches unhandled synchronous exceptions & unhandled promise rejections
 * so Node.js process NEVER exits unexpectedly.
 */
process.on('uncaughtException', (err: any) => {
  console.error('[CRASH SHIELD] Uncaught Node.js Exception intercepted:', err);
  try {
    store.audit('system', 'SERVER_CRASH_SHIELD', `Prevented server crash on uncaughtException: ${err?.message || err}`);
  } catch {}
});

process.on('unhandledRejection', (reason: any) => {
  console.error('[CRASH SHIELD] Unhandled Promise Rejection intercepted:', reason);
  try {
    store.audit('system', 'SERVER_CRASH_SHIELD', `Prevented server crash on unhandledRejection: ${reason?.message || reason}`);
  } catch {}
});

/**
 * HighLyAgent - Standalone Express App Module
 * This file creates the core backend API without binding it to a specific port
 * or attaching the Frontend (Vite).
 */
export const app = express();

app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/v1', apiRouter);
app.use('/api/v1', apiRouter);
app.use('/api', apiRouter);

// System top-level health endpoint with PostgreSQL status
app.get('/health', async (req, res) => {
  const pool = getPgPool();
  let dbStatus = pool ? 'connected (PostgreSQL source of truth)' : 'in-memory active (ready for PostgreSQL)';
  let dbLatency = 0;

  if (pool) {
    try {
      const start = Date.now();
      await pool.query('SELECT 1');
      dbLatency = Date.now() - start;
      dbStatus = `healthy (PostgreSQL source of truth, ${dbLatency}ms latency)`;
    } catch (e: any) {
      dbStatus = `connection pending/degraded: ${e?.message}`;
    }
  }

  res.json({
    status: 'ok',
    service: 'HighLyAgent Backend API',
    database: dbStatus,
    database_type: 'PostgreSQL',
    storage_mode: pool ? 'postgres_source_of_truth + hot_memory_cache' : 'in-memory_until_DATABASE_URL',
    hot_cache: {
      projects: store.clients.size,
      pg_ready: store.pgReady,
    },
    timestamp: new Date().toISOString(),
  });
});

// OpenAPI Spec and Documentation endpoint
app.get('/docs/spec', (req, res) => {
  res.json(openApiSpec);
});

app.get('/docs', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HighLyAgent API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body style="margin:0; background:#0f172a;">
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui.js"></script>
  <script>
    window.onload = () => {
      SwaggerUIBundle({
        spec: ${JSON.stringify(openApiSpec)},
        dom_id: '#swagger-ui',
      });
    };
  </script>
</body>
</html>`);
});

// Express Global Crash Shield Error Handler Middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[Express Global Error Shield]', err);
  try {
    store.audit('system', 'EXPRESS_ERROR_INTERCEPTED', `Error on ${req.method} ${req.path}: ${err?.message || err}`);
  } catch {}

  if (res.headersSent) {
    return next(err);
  }

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    success: false,
    error: {
      code: err.code || 'INTERNAL_SERVER_ERROR',
      message: 'The server intercepted an error and prevented a crash.',
      details: err.message || 'An unexpected error occurred.',
      path: req.path,
      timestamp: new Date().toISOString(),
    },
  });
});
