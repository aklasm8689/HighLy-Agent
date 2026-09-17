# HighLyAgent Backend Server

This folder contains the **complete, standalone backend API and WebSocket gateway**.

It is structured as an independent Node.js Express project.

## 🚀 Running as a Standalone Server

**To run it:**
1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and configure your API keys.
3. Run in dev mode: `npm run dev` (Starts on port 3001 by default)
4. Build for production: `npm run build`
5. Start production: `npm start`

## 🔌 Using with the Local AI Studio Frontend

To allow development within a single IDE window (like Google AI Studio Build), the main project's root `server.ts` imports the `app` module from `server/app.ts` and runs it alongside the Vite frontend on Port 3000. 

**This means you do NOT need to change any files inside this `server` folder when you separate them.** It is already built as a completely separate app!
