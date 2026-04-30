# CropAI UML Diagrams

This folder contains a full UML source pack for the current CropAI codebase.

## Included diagrams

1. `01-use-case.puml`
   Captures the main user and system interactions.

2. `02-component-diagram.puml`
   Shows how the frontend, Express backend, persistence layer, and external APIs connect.

3. `03-class-diagram.puml`
   Models the main runtime classes and data structures used by the app today.

4. `04-sequence-auth-profile.puml`
   Covers signup, verification, login, and profile fetch/update flow.

5. `05-sequence-crop-recommendation.puml`
   Describes the crop recommendation request flow.

6. `06-sequence-photo-analysis.puml`
   Describes the crop photo upload and external AI analysis pipeline.

7. `07-activity-crop-recommendation.puml`
   Shows the decision flow for recommendation generation.

8. `08-state-user-account.puml`
   Shows the user account lifecycle.

9. `09-deployment-diagram.puml`
   Shows the local/runtime deployment topology.

## How to render

If you have PlantUML installed locally:

```powershell
plantuml *.puml
```

If you use a VS Code PlantUML extension, open any `.puml` file and preview/export it.

## Notes

- These diagrams reflect the current implementation centered around `server.js`, `public/*.html`, `models/User.js`, `database.js`, `routes/auth.js`, and `services/kindwiseClient.js`.
- The diagrams also reference the MongoDB plus JSON-fallback storage approach that the project currently uses.
