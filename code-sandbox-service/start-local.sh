#!/bin/bash

# Démarrer Podman si ce n'est pas déjà fait
podman machine start

# Construire l'image Docker pour les sandboxes
cd sandbox-image
podman build -t node:20-slim-with-git .
cd ..

# Installer les dépendances
CURRENT_DIR=$(pwd)

cd api && npm install && cd ..


cd sandbox-manager && npm install && cd ..
cd frontend && yarn install && cd ..


# Charger les variables d'environnement pour le backend
export $(grep -v '^#' sandbox-manager/.env | xargs)

# Démarrer les services en arrière-plan
cd api && node app.js &
API_PID=$!
echo "API started with PID $API_PID" 
echo "Current directory: $CURRENT_DIR"


cd sandbox-manager && node manager.js &
MANAGER_PID=$!
echo "Sandbox Manager started with PID $MANAGER_PID on http://localhost:3001"

cd frontend && yarn dev &
FRONTEND_PID=$!
echo "Frontend started with PID $FRONTEND_PID on http://localhost:3000"

# Fonction pour arrêter proprement les services
cleanup() {
  echo "Stopping services..."
  kill $API_PID
  kill $MANAGER_PID
  kill $FRONTEND_PID
  wait
  echo "Services stopped"
  exit 0
}

# Capturer les signaux pour arrêter proprement
trap cleanup SIGINT SIGTERM

# Attendre que l'utilisateur arrête le script
echo "Services running. Press Ctrl+C to stop."
wait