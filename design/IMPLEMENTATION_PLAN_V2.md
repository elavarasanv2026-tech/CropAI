# CropAI v2 - Feature Implementation Plan

## Overview
This directory contains the detailed design and implementation artifacts for **CropAI v2**, a major upgrade introducing advanced AI features, real-time IoT monitoring, and a scalable architecture.

## 📁 Artifacts Summary

| File | Description | Deliverables Covered |
| :--- | :--- | :--- |
| **[database_schema.js](./database_schema.js)** | Complete Mongoose (MongoDB) schema definitions for Users, IoT Data, Crop Health, etc. | #1 (Schema), #3 (Models) |
| **[api_routes.js](./api_routes.js)** | Express.js router implementation for backend endpoints (IoT, Disease, Yield, Finance). | #2 (API Routes), #7 (Weather), #8 (Calc) |
| **[ai_service.py](./ai_service.py)** | Python Flask application containing the AI logic for Image Analysis and Yield Prediction. | #4 (AI Logic), #5 (Disease), #2 (Yield) |
| **[FRONTEND_STRUCTURE.md](./FRONTEND_STRUCTURE.md)** | Architectural guide for the React/Next.js frontend, including component hierarchy and mockups. | #5 (UI), #6 (Folder Struct) |
| **[SYSTEM_ARCHITECTURE.md](./SYSTEM_ARCHITECTURE.md)** | comprehensive guide on Security, Scalability, and Deployment strategies. | #7, #8, #9 (DevOps) |

## 🚀 How to Use These Designs

### 1. Database Migration (JSON -> MongoDB)
The current project uses `farmers.json`. To upgrade:
1.  **Install MongoDB:** Set up a local instance or use MongoDB Atlas.
2.  **Install Mongoose:** `npm install mongoose`.
3.  **Migrate Data:** Write a script to read `farmers.json` and insert records into the `User` collection defined in `database_schema.js`.

### 2. Setting up the AI Microservice
The new AI features require a Python environment:
1.  **Install Python 3.9+**
2.  **Install Dependencies:** `pip install flask tensorflow pandas pillow joblib`
3.  **Run the Service:** `python design/ai_service.py`
4.  The Node.js backend will communicate with this service via HTTP calls (as shown in `api_routes.js`).

### 3. Implementing the New APIs
1.  Copy the logic from `api_routes.js` into your main `server.js` (or a new `routes/` directory).
2.  Ensure you have the necessary middleware (body-parser, multer) configured.

### 4. Updating the Frontend
Refactor `public/*.html` files to React components following the structure in `FRONTEND_STRUCTURE.md`, or incrementally add the new charts and forms to the existing HTML/JS frontend using the logic described.

## ⚠️ Notes on Current Project State
The user is currently running a **Node.js + JSON DB** stack.
-   **Immediate Integration:** You can integrate the *logic* from `ai_service.py` by calling the Google Gemini API (like currently done in `analyze_images.js`) instead of a local Python model if you want to avoid setting up Python right now.
-   **Future Proofing:** The designs provided here assume a transition to a more robust **MERN (MongoDB, Express, React, Node)** stack with a Python AI sidecar, which is industry standard for this type of application.
