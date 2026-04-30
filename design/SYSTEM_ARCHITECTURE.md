# System Scalability, Security & Deployment Guide

## 1. Security Best Practices

### A. Authentication & Authorization
- **JWT (JSON Web Tokens):** Use short-lived Access Tokens (15 min) & long-lived Refresh Tokens (7 days).
- **Role-Based Access Control (RBAC):** Admin (All Access), Farmer (Own Data), Contributor (Read Only).
- **MFA (Multi-Factor Auth):** Implement OTP via SMS/Email for sensitive actions (e.g., Delete Account).
- **Password Hashing:** Use Bcrypt with salt rounds >= 12.

### B. Data Protection
- **Encryption at Rest:** Enable MongoDB Atlas encryption.
- **Encryption in Transit:** Enforce HTTPS/SSL/TLS 1.2+.
- **Input Validation:** Use `joi` or `zod` schema validation on ALL request bodies to prevent NoSQL Injection.
- **Sanitization:** Sanitize HTML inputs to prevent XSS (Cross-Site Scripting).

### C. Network Security
- **Rate Limiting:** Use `express-rate-limit` (e.g., 100 requests per 15 min per IP) to mitigate DDoS/Brute-force.
- **CORS Policy:** Whitelist *only* trusted frontend domains.
- **Helmet:** Use `helmet` middleware for HTTP headers security (HSTS, X-Frame-Options).

---

## 2. Scalability Suggestions

### A. Database Optimization
- **Indexing:** Create compound indexes for frequently queried fields (e.g., `{ userId: 1, timestamp: -1 }` for sensor data).
- **Sharding:** If user base grows > 1M, shard User collection by Region/Country.
- **Caching:** Use Redis to cache:
    - User Profiles
    - Weather Data (TTL: 30 min)
    - Static Content (images)

### B. Architecture Updates
- **Microservices:**
    - **Separate AI Service:** Run Python/Flask service independently (use RabbitMQ or Kafka for async processing).
    - **Separate IoT Service:** Use MQTT broker (Mosquitto) for high-frequency sensor data ingestion.
- **Load Balancing:** Use NGINX as a reverse proxy to distribute traffic across multiple Node.js instances (PM2 Cluster Mode).

### C. Asynchronous Processing
- **Queue System (BullMQ/RabbitMQ):**
    - Offload heavy tasks: Image Analysis, PDF Generation, Email Notifications.
    - Prevent main thread blocking.

---

## 3. Deployment Guide

### A. Prerequisites
- **Node.js** v18+
- **Python** 3.9+ (For AI Service)
- **MongoDB Atlas** (Managed Instance)
- **Redis** (Managed or Docker)

### B. Docker Compose Setup (Recommended)
Create `docker-compose.yml`:
```yaml
version: '3.8'
services:
  backend:
    build: ./backend
    ports:
      - "3000:3000"
    environment:
      - DB_URL=mongodb://mongo:27017/cropai
    depends_on:
      - mongo
      - redis

  ai_service:
    build: ./ai_service
    ports:
      - "5000:5000"

  mongo:
    image: mongo:latest
    volumes:
      - mongo-data:/data/db

  redis:
    image: redis:alpine
```

### C. Cloud Deployment (AWS/GCP/Vercel)
**Option 1: PaaS (Heroku/Render/Vercel)**
- **Frontend:** Deploy Next.js to **Vercel** (Global CDN, Serverless Functions).
- **Backend:** Deploy Express API to **Render** or **Railway.app**.
- **Database:** MongoDB Atlas (Free Tier available).

**Option 2: IaaS (AWS EC2)**
1. **EC2 Instance:** Ubuntu 22.04 LTS (t3.medium).
2. **PM2:** Run Node apps with PM2 process manager (`pm2 start server.js -i max`).
3. **Nginx:** Setup Reverse Proxy & SSL (Let's Encrypt Ref).
4. **CI/CD:** GitHub Actions pipeline to auto-deploy on push to `main`.

### D. Environment Variables (.env)
```
NODE_ENV=production
PORT=3000
MONGO_URI=mongodb+srv://user:pass@cluster0.abc.mongodb.net/cropai
JWT_SECRET=super_secret_key_change_me
REDIS_URL=redis://localhost:6379
OPENWEATHER_KEY=your_api_key
GEMINI_API_KEY=your_ai_key
```
