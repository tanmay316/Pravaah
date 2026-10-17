# syntax=docker/dockerfile:1
# Pravaah web app: builds the Expo web export and serves it with nginx on port 8080.
# Works on any container host (Cloud Run, Render, Fly.io, Railway, a VPS with Docker...).
#
#   docker build -f deploy/web/Dockerfile -t pravaah-web \
#     --build-arg EXPO_PUBLIC_API_URL=https://your-api \
#     --build-arg EXPO_PUBLIC_LIVEKIT_URL=wss://your-project.livekit.cloud \
#     --build-arg EXPO_PUBLIC_FIREBASE_API_KEY=... (and the other EXPO_PUBLIC_* values) .
#   docker run -d -p 8080:8080 pravaah-web
#
# EXPO_PUBLIC_* values are compiled into the JS bundle, so they must be given at build time.
# They are public web-client settings, never put server secrets here.

FROM node:20-alpine AS build
WORKDIR /app
COPY apps/expo/package.json apps/expo/package-lock.json apps/expo/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY apps/expo/ ./

ARG EXPO_PUBLIC_API_URL
ARG EXPO_PUBLIC_LIVEKIT_URL
ARG EXPO_PUBLIC_FIREBASE_API_KEY
ARG EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG EXPO_PUBLIC_FIREBASE_PROJECT_ID
ARG EXPO_PUBLIC_FIREBASE_APP_ID
ARG EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET
ARG EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
ARG EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID
ENV EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL \
    EXPO_PUBLIC_LIVEKIT_URL=$EXPO_PUBLIC_LIVEKIT_URL \
    EXPO_PUBLIC_FIREBASE_API_KEY=$EXPO_PUBLIC_FIREBASE_API_KEY \
    EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=$EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN \
    EXPO_PUBLIC_FIREBASE_PROJECT_ID=$EXPO_PUBLIC_FIREBASE_PROJECT_ID \
    EXPO_PUBLIC_FIREBASE_APP_ID=$EXPO_PUBLIC_FIREBASE_APP_ID \
    EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=$EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET \
    EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=$EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID \
    EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=$EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID

RUN npx expo export --platform web

FROM nginx:1.27-alpine
COPY deploy/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
