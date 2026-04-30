# IoT Crop Recommendation - Getting Started Guide

## 🚀 Quick Start (3 Steps)

The codebase is now split into `frontend/` and `backend/`. Start the server from the project root and it will serve the frontend automatically.

### Step 1: Run the Server
**Windows Users:**
- Double-click `START-SERVER.bat`
- Wait for the message "Server running at http://localhost:3000"

**Or use PowerShell:**
```powershell
.\START-SERVER.ps1
```

### Step 2: Open Browser
- Open Chrome, Edge, or Firefox
- Go to: **http://localhost:3000**
- You should see the login page

### Step 3: Start Using
- Create an account (Signup)
- Login with your credentials
- Enjoy the crop recommendation system!

---

## 📋 What's Fixed

### ✅ Before (Broken)
```
User clicks "Get Recommendations"
↓
Error: "Network error. Please try again"
↓
User confused - is it internet? Server? App?
↓
User frustrated - gives up
```

### ✅ After (Fixed)
```
User clicks "Get Recommendations"
↓
(If network issue) Error: "Please check your internet connection"
↓
(If invalid input) Error: "Soil type must be loamy, clay, sandy, or silty"
↓
(If server issue) Error: "Server error. Please try again later"
↓
User knows exactly what's wrong
↓
User can take action
```

---

## 🎯 Key Features

### 1. **Smart Crop Recommendations**
- Select soil type, climate, season, and water availability
- Get personalized recommendations for your farm
- See yield predictions and profit estimates

### 2. **IoT Sensor Integration**
- View real-time sensor readings
- Load sensor data directly into forms
- Monitor temperature, humidity, soil moisture, pH, and rainfall

### 3. **Photo Analysis**
- Upload photos of your crops
- AI analyzes crop health
- Get actionable recommendations
- Receive monthly care tips

### 4. **Multi-Language Support**
- Switch between English and Tamil
- All content translates automatically
- Includes error messages

---

## 🐛 Troubleshooting

### Problem: "Cannot access http://localhost:3000"
**Solution:**
```
1. Check if server is running (look for "http://localhost:3000" message)
2. Try http://127.0.0.1:3000 instead
3. Check if port 3000 is available
```

### Problem: "Port 3000 already in use"
**Solution (Windows):**
```cmd
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

### Problem: "Node.js not found"
**Solution:**
```
1. Install Node.js from https://nodejs.org/
2. Restart your computer
3. Run START-SERVER.bat again
```

### Problem: "Server starts but no connection"
**Solution:**
```
1. Kill existing node processes:
   Task Manager → Find node.exe → End Task
2. Wait 5 seconds
3. Run START-SERVER.bat again
```

---

## 📊 API Endpoints (Technical)

### Public Endpoints
```
GET  http://localhost:3000/api/sensors
GET  http://localhost:3000/api/weather
```

### Protected Endpoints (Login Required)
```
POST http://localhost:3000/api/login
POST http://localhost:3000/api/signup  
POST http://localhost:3000/api/logout
GET  http://localhost:3000/api/user
POST http://localhost:3000/api/crop-recommendation
POST http://localhost:3000/api/upload-photo
```

---

## 💾 Data Storage

- **User Data**: Stored in `farmers.json` (encrypted passwords)
- **Photos**: Stored in `public/uploads/`
- **Sessions**: In-memory (lost on server restart)

---

## 🎨 Application Pages

### Login Page (`/login.html`)
- Email/password login
- Error messages for invalid credentials
- Link to signup page

### Signup Page (`/signup.html`)
- Create new account
- Name, username, email, password
- Password confirmation
- Auto-login after signup

### Dashboard (`/dashboard.html`)
- Main application interface
- Crop recommendation form
- Photo analysis tool
- Sensor data integration
- Weather forecast
- Language selector

---

## 🔐 Security Features

✅ Password hashing (bcryptjs)
✅ Session-based authentication
✅ CORS protection
✅ Input validation
✅ Error handling without info leakage
✅ Secure file upload
✅ Session timeout (24 hours)

---

## 📱 Browser Compatibility

✅ Chrome/Chromium (v90+)
✅ Firefox (v88+)
✅ Microsoft Edge (v90+)
✅ Safari (v14+)
✅ Opera (v76+)

---

## 🆘 Getting Help

### If Something Doesn't Work

1. **Check Console:**
   - Press F12 in browser
   - Click "Console" tab
   - Look for error messages

2. **Check Server Output:**
   - Look at the command window running the server
   - Check for error messages

3. **Try These Steps:**
   ```
   1. Close browser
   2. Stop server (Ctrl+C in command window)
   3. Wait 5 seconds
   4. Start server again: START-SERVER.bat
   5. Open browser fresh: http://localhost:3000
   6. Clear cache: Ctrl+Shift+Delete
   ```

4. **Check Network:**
   - Make sure you're not behind a restrictive firewall
   - Try a different browser
   - Try http://127.0.0.1:3000

---

## 📚 File Structure

```
gokul/
├── server.js                    Main server file
├── database.js                  Database manager
├── package.json                 Dependencies
├── farmers.json                 User database
├── START-SERVER.bat             Quick start (Windows)
├── START-SERVER.ps1             Quick start (PowerShell)
├── HOW_TO_RUN.md                Detailed setup guide
├── RESOLUTION_SUMMARY.md        What was fixed
├── public/
│   ├── index.html               Home page
│   ├── login.html               Login page
│   ├── signup.html              Signup page
│   ├── dashboard.html           Main dashboard
│   └── uploads/                 Photo storage
└── docs/
    └── [Documentation files]
```

---

## ✨ What's New

### Recently Fixed
- ✅ Network error messages are now specific
- ✅ All API endpoints have proper error handling
- ✅ Input validation on all forms
- ✅ Bilingual error messages (English/Tamil)
- ✅ Easy server startup scripts
- ✅ Comprehensive error logging

### Verified Working
- ✅ User registration and login
- ✅ Crop recommendations
- ✅ Sensor data loading
- ✅ Weather forecasts
- ✅ Photo analysis
- ✅ Multi-language UI
- ✅ Session management

---

## 🎓 Usage Tips

1. **First Time?**
   - Sign up with email and password
   - Server will auto-login you
   - Go straight to dashboard

2. **Getting Recommendations?**
   - Fill in all required fields
   - Or click "Load from Sensors" for auto-fill
   - Click "Get Recommendations"
   - Results show top crop recommendations

3. **Analyzing Crops?**
   - Click "Choose Photo"
   - Upload a clear photo of your crop
   - Click "Analyze Photo"
   - Get health score and recommendations

4. **Checking Weather?**
   - See 3-day forecast on dashboard
   - Updated when page loads
   - Check before planting/harvesting

---

## 🎯 Common Tasks

### Create New Account
1. Go to `/signup.html`
2. Fill in: Name, Username, Email, Password
3. Click "Sign Up"
4. You're automatically logged in

### Login to Existing Account
1. Go to `/login.html`
2. Enter email and password
3. Click "Login"
4. Redirected to dashboard

### Get Crop Recommendations
1. Select soil type
2. Select climate
3. Select season
4. Select water availability
5. Enter farm size
6. Click "Get Recommendations"
7. See results with profit predictions

### Analyze a Photo
1. Click "Choose Photo"
2. Select crop photo from your computer
3. Click "Analyze Photo"
4. Get health score and actions
5. See monthly care recommendations

### Load Sensor Data
1. Click "Load from Sensors" button
2. Temperature, humidity, moisture, pH, rainfall auto-populate
3. Use for recommendations

### Change Language
1. Click language dropdown (top-right)
2. Select Tamil or English
3. All content updates immediately

---

## 🎉 You're All Set!

Everything is now working correctly. Start the server and enjoy using the IoT Crop Recommendation System!

**Questions?** Check `HOW_TO_RUN.md` for detailed information.

---

**Version**: 1.0
**Last Updated**: January 30, 2026
**Status**: ✅ Production Ready
