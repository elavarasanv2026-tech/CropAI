# IoT Crop Recommendation System - Running the Server

## ✅ System Status
The server is now fully functional! All network errors have been resolved.

## Quick Start

The project is now separated into:
- `frontend/` for static client files
- `backend/` for the Node.js server, API routes, services, and data files

### Option 1: Using Batch File (Windows)
Simply double-click the file:
```
START-SERVER.bat
```

The batch file will:
- Check if Node.js is installed
- Install dependencies if needed
- Start the server
- Display the URL to access the application

### Option 2: Using PowerShell
Run the following command in PowerShell:
```powershell
.\START-SERVER.ps1
```

The PowerShell script will:
- Start the server as a background job
- Verify the server is running
- Display the server URL
- Monitor the server process

### Option 3: Manual Start (Command Prompt/PowerShell)
```bash
cd path\to\gokul
node backend/server.js
```

Then open your browser to: **http://localhost:3000**

## 🌐 Accessing the Application

### Dashboard
- **URL**: http://localhost:3000
- **Port**: 3000

### Available Pages
- Login: `/login.html`
- Signup: `/signup.html`
- Dashboard: `/dashboard.html` (after login)

## API Endpoints (for Testing)

All API endpoints are now working:

### Public Endpoints
```
GET  /api/sensors       - Get IoT sensor readings
GET  /api/weather       - Get weather forecast
```

### Authentication Endpoints
```
POST /api/signup        - Create new account
POST /api/login         - Login to account
POST /api/logout        - Logout from account
GET  /api/user          - Get current user info (requires auth)
```

### Recommendation Endpoints
```
POST /api/crop-recommendation    - Get crop recommendations (requires auth)
POST /api/upload-photo           - Analyze crop photo (requires auth)
```

## 📋 Requirements

- **Node.js**: v14 or higher (tested with v23.1.0)
- **npm**: Included with Node.js
- **Port 3000**: Must be available (not in use by another application)

## 🔧 Installation

1. **Install Node.js** from https://nodejs.org/
2. **Navigate to project directory**:
   ```
   cd path\to\gokul
   ```
3. **Install dependencies**:
   ```
   npm install
   ```

## ⚠️ Troubleshooting

### Port 3000 Already in Use
If you get an error that port 3000 is already in use:

**Windows Command Prompt:**
```cmd
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

**PowerShell:**
```powershell
Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.ProcessName -eq "node"}
Stop-Process -Name "node" -Force
```

Then restart the server.

### Node.js Not Found
Make sure Node.js is installed and added to your PATH:
```cmd
node --version
npm --version
```

### Cannot Connect to Localhost:3000
1. Check if the server is running
2. Try http://127.0.0.1:3000 instead of http://localhost:3000
3. Check if port 3000 is blocked by firewall
4. Verify port 3000 is available: `netstat -ano | findstr :3000`

## 📝 Server Features

### Authentication
- ✅ User registration (signup)
- ✅ User login with session management
- ✅ Password hashing with bcryptjs
- ✅ Session-based authentication

### Crop Recommendations
- ✅ AI-based crop recommendation engine
- ✅ Input validation
- ✅ Profitability calculations
- ✅ Seasonality analysis
- ✅ Sustainability scoring

### Photo Analysis
- ✅ Crop photo upload & analysis
- ✅ Health score calculation
- ✅ Disease detection
- ✅ Monthly recommendations

### IoT Sensor Integration
- ✅ Temperature monitoring
- ✅ Humidity tracking
- ✅ Soil moisture analysis
- ✅ pH level monitoring
- ✅ Rainfall tracking

### Multi-language Support
- 🇺🇸 English
- 🇮🇳 Tamil (தமிழ்)

## 🎯 What's Been Fixed

### Network Errors
- ✅ Replaced generic error messages with specific, helpful messages
- ✅ Added comprehensive error handling on server
- ✅ Improved error logging for debugging
- ✅ Added input validation on all endpoints
- ✅ Added global error handler middleware

### API Reliability
- ✅ All endpoints tested and working
- ✅ CORS properly configured
- ✅ Session management fixed
- ✅ Database persistence working
- ✅ File upload handling improved

## 💾 Database

The application uses a JSON file-based database:
- **File**: `farmers.json`
- **Location**: Root project directory
- **Auto-created**: Yes, on first user creation

## 📊 Project Structure

```
gokul/
├── server.js                 # Main Express server
├── database.js               # Database management
├── package.json              # Dependencies
├── farmers.json              # User database (auto-created)
├── START-SERVER.bat          # Windows batch start script
├── START-SERVER.ps1          # PowerShell start script
└── public/
    ├── index.html            # Home page
    ├── login.html            # Login page
    ├── signup.html           # Signup page
    ├── dashboard.html        # Main dashboard
    └── uploads/              # Photo upload directory
```

## 🚀 Server Startup

When you start the server, you should see:
```
IoT Crop Recommendation server running at http://localhost:3000
```

Then open your browser to that URL.

## 📞 Support

If you encounter any issues:
1. Check the console output for error messages
2. Verify Node.js is installed: `node --version`
3. Check port 3000 is available: `netstat -ano | findstr :3000`
4. Restart the server and try again
5. Clear browser cache (Ctrl+Shift+Delete)

## ✨ Testing Checklist

- ✅ Server starts without errors
- ✅ Dashboard loads on http://localhost:3000
- ✅ Sensor endpoint responds
- ✅ Weather endpoint responds
- ✅ User authentication works
- ✅ Crop recommendations work
- ✅ Photo analysis works
- ✅ Error messages are helpful
- ✅ All endpoints have proper error handling

**All tests passing!** The application is ready to use.
