# 🌿 CropAI Social Authentication Setup Guide

This guide will walk you through setting up **real** Google, Facebook, and Twitter login for your project using Firebase.

---

### Step 1: Create a Firebase Project
1. Go to the [Firebase Console](https://console.firebase.google.com/).
2. Click **Add Project** and give it a name (e.g., "CropAI").
3. (Optional) Enable Google Analytics and click **Create Project**.
4. Once ready, click **Continue** to enter your project dashboard.

---

### Step 2: Enable Authentication Providers
1. In the left sidebar, click **Build** > **Authentication**.
2. Click **Get Started**.
3. Go to the **Sign-in method** tab.

#### A. Enable Google
1. Click **Google** > **Enable**.
2. Select your **Project support email**.
3. Click **Save**.

#### B. Enable Facebook
1. Click **Add new provider** > **Facebook**.
2. You will need an "App ID" and "App Secret" from the [Meta for Developers](https://developers.facebook.com/) portal.
3. Follow the instructions on the Firebase screen to add the "OAuth redirect URI" to your Facebook App settings.

#### C. Enable Twitter
1. Click **Add new provider** > **Twitter**.
2. You will need an "API Key" and "API Secret" from the [Twitter Developer Portal](https://developer.twitter.com/).
3. Follow the instructions on the Firebase screen to enable "OAuth 1.0a" or "OAuth 2.0" in your Twitter App.

---

### Step 3: Get Your Project Credentials
1. Click the **Project Settings** (gear icon ⚙️) in the left sidebar.
2. Under "General" > "Your apps", click the **Web icon** (`</>`).
3. Register your app (e.g., "CropAI Web").
4. Copy the `firebaseConfig` object values. It looks like this:
   ```javascript
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "crop-ai.firebaseapp.com",
     projectId: "crop-ai",
     storageBucket: "crop-ai.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456:web:abcd"
   };
   ```

---

### Step 4: Update Your `.env` File
Open your `.env` file in VS Code and replace the placeholders with your actual keys from Step 3:

```bash
FIREBASE_API_KEY=AIza... (your real key)
FIREBASE_AUTH_DOMAIN=crop-ai.firebaseapp.com
FIREBASE_PROJECT_ID=crop-ai
FIREBASE_STORAGE_BUCKET=crop-ai.appspot.com
FIREBASE_MESSAGING_SENDER_ID=123456789
FIREBASE_APP_ID=1:123456:web:abcd
```

---

### Step 5: Test It!
1. Save your `.env` file.
2. Refresh your login page (`http://localhost:3000/login.html`).
3. Click the **Google icon**. A real Google popup should now appear!

---

### 💡 Troubleshooting
* **"Unauthorized Domain"**: If you get a "domain not authorized" error, go to **Firebase Console** > **Authentication** > **Settings** > **Authorized Domains** and ensure `localhost` is in the list.
* **Popup Blocked**: Ensure your browser isn't blocking the login popup.
