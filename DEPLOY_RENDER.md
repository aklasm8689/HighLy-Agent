# Deployment Guide for Render.com

## Quick Start (5 minutes)

### 1. GitHub Repository
```bash
# Initialize git if not done
git init
git add .
git commit -m "Initial commit for Render deployment"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/highly-agent.git
git push -u origin main
```

### 2. Create Backend Service on Render
1. Go to https://render.com/dashboard
2. Click "New +" → "Web Service"
3. Connect your GitHub repository
4. Configure:
   - **Name:** highly-agent-backend
   - **Environment:** Node
   - **Build Command:** `npm ci && npm run build`
   - **Start Command:** `node dist/server.cjs`
   - **Health Check Path:** `/health`
   - **Region:** Singapore (closest to you) or Oregon

### 3. Set Environment Variables
In Render dashboard, add these variables:
```
DATABASE_URL=postgresql://highly_agent_db_owner:npg_d4qh0twXmulN@ep-calm-field-b3iwyy1j-pooler.c-4.ap-southeast-1.aws.neon.tech/highly_agent_db?sslmode=require
JWT_SECRET_KEY=your-super-secret-jwt-key-change-in-production
ADMIN_EMAIL=admin@highlyagent.com
ADMIN_PASSWORD=admin123
GEMINI_API_KEY=your-actual-gemini-key-here
MANAGEMENT_API_KEY=hla_mgmt_secret_super_key_2026
BACKEND_PORT=3001
NODE_ENV=production
```

### 4. Create Frontend Service (Optional)
If you have a separate frontend:
- **Name:** highly-agent-frontend
- **Environment:** Static
- **Publish Path:** `./dist`
- **Build Command:** `npm run build`

## Important Notes

### Free Tier Limitations
- **750 hours/month free** (enough for 1 service running 24/7)
- **Spin-down after 15 min idle** - will wake on next request (2-5s cold start)
- **No persistent disk** - use Neon.tech for database (already configured)

### WebSocket Support
Render supports WebSockets. Your `/ws` endpoint will work.

### Cold Start Behavior
Your app has in-memory cache that warms up on first request. This is fine for demo/testing.

### Domain
You'll get: `https://highly-agent-backend.onrender.com`
Can add custom domain later.

## Testing Credentials
- Email: admin@highlyagent.com
- Password: admin123
