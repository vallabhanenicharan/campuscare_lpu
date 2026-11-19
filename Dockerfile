FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    CAMPUSCARE_HOST=0.0.0.0 \
    CAMPUSCARE_DATA_DIR=/data \
    CAMPUSCARE_SECURE_COOKIE=1

COPY server.js index.html app.js staff-queue.js ./
COPY styles.css premium.css experience.css lpu-theme.css reference-ui.css features.css staff-queue.css mobile-improvements.css roles.css ./
COPY lpu-logo.svg lpu-hostel.jpg ./

CMD ["node", "server.js"]
