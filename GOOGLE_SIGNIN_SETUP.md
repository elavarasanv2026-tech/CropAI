# Google Sign-In Setup Guide

This guide will help you set up Google Sign-In for the IoT Crop Recommendation application.

## Prerequisites

- A Google Cloud Project
- Node.js and npm installed
- The application running locally or on a server

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click on the project dropdown and select "New Project"
3. Enter a project name (e.g., "IoT Crop Recommendation")
4. Click "Create"

## Step 2: Enable Google OAuth2 API

1. In the Google Cloud Console, go to "APIs & Services" → "Library"
2. Search for "Google+ API"
3. Click on it and select "Enable"
4. Alternatively, search for "Identity and Access Management (IAM) API" and enable it

## Step 3: Create OAuth 2.0 Credentials

1. Go to "APIs & Services" → "Credentials"
2. Click "Create Credentials" → "OAuth client ID"
3. If prompted, configure the OAuth consent screen first:
   - Select "External" for user type
   - Fill in the application name, user support email, and developer contact information
   - Add required scopes: `email`, `profile`
4. For the OAuth client ID:
   - Application type: **Web application**
   - Name: IoT Crop Recommendation
   - Authorized JavaScript origins:
     - `http://localhost:3000` (for development)
     - `http://127.0.0.1:3000` (for development)
     - Add your production domain if applicable
   - Authorized redirect URIs:
     - `http://localhost:3000/` (for development)
     - `http://localhost:3000/login.html` (for development)
     - Add your production URLs if applicable

5. Click "Create"
6. Copy your **Client ID** (you'll need this)

## Step 4: Install Dependencies

Run the following command in your project directory:

```bash
npm install
```

This will install the `google-auth-library` package along with other dependencies.

## Step 5: Add Your Google Client ID

### Option A: Environment Variable (Recommended)

Create a `.env` file in the project root:

```
GOOGLE_CLIENT_ID=your_client_id_here
```

Then update your `server.js` to load environment variables:

```bash
npm install dotenv
```

Add this to the top of `server.js`:

```javascript
require('dotenv').config();
```

### Option B: Direct Update

In `login.html`, find this line:

```javascript
client_id: 'YOUR_GOOGLE_CLIENT_ID_HERE',
```

Replace `'YOUR_GOOGLE_CLIENT_ID_HERE'` with your actual Google Client ID.

Also in `server.js`, find:

```javascript
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID_HERE';
```

Replace `'YOUR_GOOGLE_CLIENT_ID_HERE'` with your actual Google Client ID.

## Step 6: Test Google Sign-In

1. Start your server:
   ```bash
   npm start
   ```

2. Open your browser and navigate to `http://localhost:3000/login.html`

3. You should see a "Sign in with Google" button below the login form

4. Click the button and follow the Google authentication flow

5. After successful authentication, you should be redirected to the dashboard

## How It Works

1. **Frontend (login.html)**:
   - Loads the Google Sign-In SDK
   - When user clicks "Sign in with Google", Google authentication dialog appears
   - Google returns a JWT token
   - Token is sent to backend via `/api/google-login` endpoint

2. **Backend (server.js)**:
   - Receives the JWT token
   - Verifies the token using Google OAuth2 Client
   - Extracts user information (email, name, etc.)
   - Checks if user exists in database
   - If not, creates a new user account automatically
   - Sets up user session
   - Returns success response

3. **Database**:
   - New users created via Google Sign-In are stored with their Google ID
   - Email is used to prevent duplicate accounts

## Troubleshooting

### Error: "Invalid Client ID"
- Make sure you copied the entire Client ID correctly
- Verify the Client ID matches what's shown in Google Cloud Console

### Error: "Redirect URI Mismatch"
- Make sure your application's URL (localhost:3000 or your domain) is added to "Authorized redirect URIs" in Google Cloud Console
- Wait a few minutes for changes to take effect

### Error: "Token validation failed"
- Ensure your Google Client ID is correct
- Check that the token hasn't expired
- Verify your server has internet connection to verify tokens

### Google button not appearing
- Make sure the Google Sign-In SDK script is loaded: `<script src="https://accounts.google.com/gsi/client"></script>`
- Check browser console for any JavaScript errors

## Security Notes

- Always use HTTPS in production
- Never commit your Client ID to version control if sensitive
- Use environment variables for credentials
- The Google ID is hashed when stored as the initial password
- Users can still log in with their email if they set a password later

## Additional Resources

- [Google Identity Services Documentation](https://developers.google.com/identity)
- [Google OAuth 2.0 Documentation](https://developers.google.com/identity/protocols/oauth2)
- [google-auth-library-nodejs](https://github.com/googleapis/google-auth-library-nodejs)
