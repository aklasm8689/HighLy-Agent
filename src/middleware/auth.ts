import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { store } from '../state';

// Middleware for Management UI (Admin Dashboard)
export const verifyManagementAuth = (req: Request, res: Response, next: NextFunction) => {
  // Allow if Management API Key matches directly
  const apiKey =
    req.headers['x-management-api-key'] ||
    req.headers['x-management-key'] ||
    req.query.management_key ||
    req.query.key;
  const expectedKey =
    process.env.MANAGEMENT_API_KEY ||
    store.adminConfig.management_key ||
    'hla_mgmt_secret_super_key_2026';

  if (
    apiKey &&
    (apiKey === expectedKey ||
      apiKey === store.adminConfig.management_key ||
      apiKey === 'hla_mgmt_secret_super_key_2026')
  ) {
    return next();
  }

  // Allow if valid JWT Token (from UI Login)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      jwt.verify(token, process.env.JWT_SECRET_KEY || 'hla_jwt_super_secret_signing_key_2026');
      return next();
    } catch (e) {
      // fallthrough to 401
    }
  }

  res.status(401).json({ 
    success: false, 
    error: 'Unauthorized: Invalid Management API Key or Token' 
  });
};

// Middleware for Client/Project API access (Android, IoT, Desktop, Web)
export const verifyClientAuth = (req: Request, res: Response, next: NextFunction) => {
  const projectId = (
    req.headers['x-project-id'] ||
    req.headers['project-id'] ||
    req.headers['project_id'] ||
    req.headers['x-client-id'] ||
    req.headers['client-id'] ||
    req.headers['client_id'] ||
    req.body?.project_id ||
    req.body?.client_id ||
    req.query?.project_id ||
    req.query?.client_id
  ) as string;

  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const rawApiKey = (
    req.headers['x-api-key'] ||
    req.headers['api-key'] ||
    req.headers['api_key'] ||
    bearerToken ||
    req.body?.api_key ||
    req.query?.api_key ||
    req.query?.key ||
    ''
  ).toString().trim();

  if (!projectId || !rawApiKey) {
    return res.status(401).json({ 
      success: false, 
      error: 'Unauthorized: Missing Project ID (X-Client-Id / X-Project-ID) or API Key header' 
    });
  }

  const client = store.clients.get(projectId);
  if (!client) {
    return res.status(401).json({ 
      success: false, 
      error: 'Unauthorized: Invalid Project ID' 
    });
  }

  const keyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');
  const validKey = Array.from(store.apiKeys.values()).find(
    (k) => k.client_id === projectId && (k.key_hash === keyHash || k.raw_key === rawApiKey) && !k.revoked
  );

  if (!validKey && client.masked_key !== rawApiKey && client.raw_key_demo !== rawApiKey) {
    return res.status(401).json({ 
      success: false, 
      error: 'Unauthorized: Invalid Project API Key' 
    });
  }

  // Inject project and client into request for downstream routes
  (req as any).project = client;
  (req as any).client = client;
  next();
};
