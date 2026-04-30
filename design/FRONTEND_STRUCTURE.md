# Frontend Folder Structure & Architecture (React/Next.js Recommended)

### Suggested Tech Stack:
- **Framework:** React.js + Next.js (SSR for SEO)
- **Styling:** Tailwind CSS (Modern & Clean)
- **Charts:** Chart.js or Recharts
- **State Management:** Redux Toolkit or Zustand
- **Icons:** Lucide-React or Heroicons

```
/frontend
 ├── /components
 │   ├── /charts          # Analytics Visualizations
 │   │   ├── YieldChart.js
 │   │   ├── WaterUsageGraph.js
 │   │   └── ProfitMarginChart.js
 │   ├── /cards           # Dashboard UI Cards
 │   │   ├── MetricCard.js
 │   │   ├── WeatherCard.js
 │   │   └── CropHealthCard.js
 │   ├── /forms           # Input Forms
 │   │   ├── CalculatorForm.js
 │   │   └── AddCropForm.js
 │   ├── /layout          # Layout Wrapper
 │   │   ├── Sidebar.js
 │   │   ├── Navbar.js
 │   │   └── Footer.js
 │   ├── /modals          # Popups
 │   │   ├── AlertDetails.js
 │   │   └── ImageAnalysisResult.js
 │   └── /ui              # Atomic Components
 │       ├── Button.js
 │       ├── Input.js
 │       └── Badge.js
 ├── /pages
 │   ├── /dashboard       # Main Dashboard View
 │   ├── /analytics       # Advanced Analytics Page
 │   ├── /recommendations # AI Crop Picker
 │   ├── /disease-detect  # Image Upload & Results
 │   ├── /iot             # Live Sensor Feeds
 │   ├── /settings        # User Profile & Alerts Config
 │   └── /auth            # Login/Signup
 ├── /hooks               # Custom React Hooks
 │   ├── useWeather.js
 │   ├── useSensors.js
 │   └── useAuth.js
 ├── /services            # API Integration
 │   ├── api.js           # Axios Instance
 │   ├── authService.js
 │   └── cropService.js
 ├── /styles              # Global CSS
 │   └── globals.css
 └── /utils               # Helpers
     ├── formatDate.js
     └── calculateProfit.js
```

---

# UI Mockups & Component Logic

### 1. Crop Health Card (Dashboard)
**Props:** `cropName`, `healthScore`, `lastCheckDate`
**UI:**
- **Green Ring** (if score > 80): "Excellent Health"
- **Yellow Ring** (if score 50-80): "Needs Attention"
- **Red Ring** (if score < 50): "Critical - Disease Detected"

**Example JSX:**
```jsx
<div className="card">
  <h3>{cropName}</h3>
  <CircularProgress value={healthScore} color={healthScore > 80 ? 'green' : 'red'} />
  <p className="text-sm text-gray-500">Last checked: {formatDate(lastCheckDate)}</p>
</div>
```

### 2. Predictive Yield Graph (Chart.js)
**Component:** `YieldChart.js`
**Data Source:** `/api/yield-forecast`
**Visualization:** Line chart showing expected yield over time vs actual yield.

**Configuration:**
```javascript
const data = {
  labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May'],
  datasets: [
    {
      label: 'Predicted Yield (kg)',
      data: [1200, 1500, 1800, 2100, 2400],
      borderColor: 'rgb(75, 192, 192)',
      tension: 0.1
    }
  ]
};
```

### 3. Smart Alerts Badge
**Component:** `Navbar.js`
**Feature:** Polls `/api/alerts/unread` every 60 seconds.
**Logic:**
```javascript
const { alerts } = useAlerts();
return (
  <div className="relative">
    <BellIcon />
    {alerts.length > 0 && (
      <span className="absolute top-0 right-0 bg-red-500 text-white rounded-full px-2 text-xs">
        {alerts.length}
      </span>
    )}
  </div>
);
```

### 4. Cost Calculator Form
**Component:** `CalculatorForm.js`
**State:** `seedCost`, `laborCost`, `waterCost`, `estYield`, `pricePerUnit`
**Output:** Dynamic calculation of `Profit = (Yield * Price) - (Costs)`
**UI:** 
- Input fields with floating labels.
- Live updating "Estimated Profit" metric at the bottom.
- "Export PDF" button to download report.

