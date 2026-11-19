# CampusCare on Render

This folder contains the current CampusCare demo. Push these files to the Git repository and branch connected to the existing Render web service, then use Render's deploy page if automatic deployment is off. Render builds the included Dockerfile and supplies `PORT`.

The app stores accounts, complaints and photos in SQLite at `/data`. A free Render web service loses its local files on restart, redeploy or spin-down. For persistent data, use a paid service with a persistent disk mounted at `/data`, or replace SQLite with external persistent storage. Existing local `data/` is intentionally not included.

To enable staff registration in a hosted service, set `CAMPUSCARE_STAFF_REGISTRATION_CODE` to a private value in the Render dashboard. Without it, hosted staff registration is disabled. Anyone with the code can register as staff. This is a demo and does not verify account identities or email addresses.

Run `npm test` to check the role and complaint workflow. Node.js 24 or newer is required.
