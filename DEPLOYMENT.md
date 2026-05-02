# CropAI Deployment Guide

This project is ready to be hosted as a single Node.js web service because the backend already serves the `frontend/` files and the frontend uses relative `/api/...` requests.

## Recommended Hosting Shape

- Host the whole project as one Node web service.
- Use MongoDB Atlas for `MONGO_URI`.
- Set `APP_URL` to your final public URL.
- Keep secrets in host environment variables, not in files committed to Git.

## Quick Deploy on Render

Render supports a health check path and `render.yaml` blueprints for Node web services:
- https://render.com/docs/health-checks

MongoDB Atlas documents network access and a Render integration path here:
- https://www.mongodb.com/docs/atlas/reference/partner-integrations/render/
- https://www.mongodb.com/docs/atlas/security/ip-access-list/

### 1. Push the repo to GitHub

Make sure your repository contains:
- `package.json`
- `backend/server.js`
- `render.yaml`

### 2. Create a MongoDB Atlas database

In Atlas:
- Create a cluster.
- Create a database user.
- Copy the Node connection string for `MONGO_URI`.
- Allow access from your hosting environment.

### 3. Create the Render web service

In Render:
- Click `New`.
- Choose `Blueprint` if you want Render to read `render.yaml`, or choose `Web Service` and enter the same settings manually.
- Connect your GitHub repository.

If you create it manually, use:
- Runtime: `Node`
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/api/health`

### 4. Add environment variables

Minimum required:
- `NODE_ENV=production`
- `TRUST_PROXY=1`
- `SESSION_SECRET=<long random value>`
- `APP_URL=https://your-public-domain.onrender.com`
- `MONGO_URI=<your atlas connection string>`

Add the rest only if you use those features:
- `EMAIL_USER`, `EMAIL_PASS` or `SMTP_AUTH_USER`, `SMTP_AUTH_PASS`
- `GOOGLE_CLIENT_ID`
- `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_APP_ID`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `WEATHERSTACK_API_KEY`
- `PLANT_ID_API_KEY`
- `KINDWISE_API_KEY`

### 5. Deploy and verify

After deploy:
- Open `/api/health`
- Open `/`
- Test signup/login
- Test password reset
- Test any AI/image-analysis feature whose API key you configured

## Notes

- If `MONGO_URI` is missing or Atlas is unreachable, the app falls back to `backend/farmers.json`. That is useful for local development, but for real hosting you should use MongoDB Atlas.
- Email verification and password reset links now use `APP_URL` when it is configured, which is important in production.
- Sessions are now configured to work behind HTTPS proxies when `NODE_ENV=production` and `TRUST_PROXY=1`.
