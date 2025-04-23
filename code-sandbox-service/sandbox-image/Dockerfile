FROM node:20-slim-with-git

# Installer Git et créer le répertoire sandbox
RUN apt-get update && \
    apt-get install -y git && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /sandbox

WORKDIR /sandbox

# Commande par défaut pour garder le conteneur en vie
CMD ["tail", "-f", "/dev/null"]