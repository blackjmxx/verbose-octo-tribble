import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

interface LogViewerProps {
  sandboxId: string | null;
  apiBaseUrl: string;
  processId?: string | null;
}

const LogViewer: React.FC<LogViewerProps> = ({
  sandboxId,
  apiBaseUrl,
  processId,
}) => {
  const [logs, setLogs] = useState<string>("");
  const [socket, setSocket] = useState<any>(null);
  const [connected, setConnected] = useState<boolean>(false);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [currentOffset, setCurrentOffset] = useState<number>(0);
  const [pollingEnabled, setPollingEnabled] = useState<boolean>(true);
  const [isRestarting, setIsRestarting] = useState<boolean>(false);
  const [exposedUrl, setExposedUrl] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState<boolean>(false);
  const [isExposing, setIsExposing] = useState<boolean>(false);

  // Nouveaux états pour la prévisualisation
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState<boolean>(false);
  const [previewInstanceId, setPreviewInstanceId] = useState<string | null>(
    null
  );

  const logContainerRef = useRef<HTMLDivElement>(null);
  const logsPollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Initialiser la connexion Socket.IO
  useEffect(() => {
    if (!sandboxId) return;

    const socketUrl = apiBaseUrl.replace(/^http/, "ws");
    const newSocket = io(socketUrl);

    newSocket.on("connect", () => {
      console.log("Socket connected");
      setConnected(true);

      // Rejoindre la room du sandbox
      newSocket.emit("join-sandbox", sandboxId);
    });

    newSocket.on("disconnect", () => {
      console.log("Socket disconnected");
      setConnected(false);
    });

    newSocket.on("log", (logEntry: { data: string; type: string }) => {
      console.log("Received log via socket:", logEntry);
      setLogs((prev) => prev + logEntry.data + "\n");

      // Auto-scroll
      if (autoScroll && logContainerRef.current) {
        logContainerRef.current.scrollTop =
          logContainerRef.current.scrollHeight;
      }
    });

    setSocket(newSocket);

    return () => {
      if (newSocket) {
        newSocket.emit("leave-sandbox", sandboxId);
        newSocket.disconnect();
      }
    };
  }, [sandboxId, apiBaseUrl]);

  // Configurer le polling des logs si processId est fourni
  useEffect(() => {
    if (!processId || !pollingEnabled) return;

    // Fonction pour récupérer les logs
    const fetchLogs = async () => {
      try {
        console.log(
          `Fetching logs for process ${processId}, offset: ${currentOffset}`
        );
        const response = await fetch(
          `${apiBaseUrl}/processes/${processId}/logs?offset=${currentOffset}`
        );

        if (!response.ok) {
          console.error(
            `HTTP Error: ${response.status} - ${response.statusText}`
          );
          return;
        }

        const data = await response.json();

        if (data.logs) {
          console.log(`Received ${data.logs.length} bytes of logs`);
          setLogs((prev) => prev + data.logs);
          setCurrentOffset(data.nextOffset);

          // Auto-scroll
          if (autoScroll && logContainerRef.current) {
            logContainerRef.current.scrollTop =
              logContainerRef.current.scrollHeight;
          }
        }

        if (data.status === "completed" || data.status === "error") {
          console.log(
            `Process ${processId} is ${data.status}, stopping polling`
          );
          setPollingEnabled(false);
        }
      } catch (error) {
        console.error("Error fetching logs:", error);
      }
    };

    // Récupérer les logs immédiatement
    fetchLogs();

    // Configurer l'intervalle de polling
    logsPollingIntervalRef.current = setInterval(fetchLogs, 2000);

    return () => {
      if (logsPollingIntervalRef.current) {
        clearInterval(logsPollingIntervalRef.current);
      }
    };
  }, [processId, currentOffset, apiBaseUrl, pollingEnabled]);

  // Nettoyage de la prévisualisation lors du démontage
  useEffect(() => {
    return () => {
      if (previewInstanceId && sandboxId) {
        fetch(
          `${apiBaseUrl}/sandboxes/${sandboxId}/preview/${previewInstanceId}`,
          {
            method: "DELETE",
          }
        ).catch(console.error);
      }
    };
  }, [previewInstanceId, sandboxId, apiBaseUrl]);

  // Fonction pour redémarrer le conteneur
  const handleRestart = async () => {
    if (!sandboxId) return;

    try {
      setIsRestarting(true);
      setLogs((prev) => `${prev}\n[INFO] Redémarrage du conteneur en cours...`);

      const response = await fetch(
        `${apiBaseUrl}/sandboxes/${sandboxId}/restart`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      const data = await response.json();

      if (data.success) {
        setLogs((prev) => `${prev}\n[INFO] Conteneur redémarré avec succès`);

        // Si un nouveau processId est retourné, mettre à jour pour le polling
        if (data.processId) {
          // Réinitialiser l'offset pour le nouveau processus
          setCurrentOffset(0);
          setPollingEnabled(true);

          // Vous pouvez propager ce changement au composant parent si nécessaire
          // onProcessIdChange?.(data.processId);
        }
      } else {
        setLogs(
          (prev) => `${prev}\n[ERROR] Échec du redémarrage: ${data.error}`
        );
      }
    } catch (error) {
      setLogs(
        (prev) =>
          `${prev}\n[ERROR] Erreur lors du redémarrage: ${error.message}`
      );
    } finally {
      setIsRestarting(false);
    }
  };

  // Fonction pour exposer le port et afficher le preview
  const exposeContainerPort = async (port: number) => {
    if (!sandboxId) return;

    try {
      setIsExposing(true);
      setLogs(
        (prev) =>
          `${prev}\n[INFO] Exposition du port ${port} et préparation du preview...`
      );

      const response = await fetch(
        `${apiBaseUrl}/sandboxes/${sandboxId}/expose-port`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ port }),
        }
      );

      const data = await response.json();

      if (data.success) {
        setExposedUrl(data.url);
        setShowPreview(true); // Afficher automatiquement le preview
        setLogs(
          (prev) =>
            `${prev}\n[INFO] Port ${port} exposé avec succès: ${data.url}`
        );
        setLogs((prev) => `${prev}\n[INFO] Preview de l'application activé`);
      } else {
        setLogs(
          (prev) =>
            `${prev}\n[ERROR] Échec de l'exposition du port: ${data.error}`
        );
      }
    } catch (error) {
      setLogs(
        (prev) =>
          `${prev}\n[ERROR] Erreur lors de l'exposition du port: ${error.message}`
      );
    } finally {
      setIsExposing(false);
    }
  };

  // Basculer l'affichage du preview
  const togglePreview = () => {
    setShowPreview(!showPreview);
    setLogs(
      (prev) =>
        `${prev}\n[INFO] Preview ${!showPreview ? "activé" : "désactivé"}`
    );
  };

  // Effacer les logs
  const clearLogs = () => {
    setLogs("");
    setCurrentOffset(0);
  };

  // Nouvelle fonction pour créer une prévisualisation
  const createPreview = async (port: number = 3000) => {
    if (!sandboxId) return;

    try {
      setIsLoadingPreview(true);
      setLogs(
        (prev) =>
          `${prev}\n[INFO] Création d'une prévisualisation sur le port ${port}...`
      );

      const response = await fetch(
        `${apiBaseUrl}/sandboxes/${sandboxId}/preview`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ port }),
        }
      );

      const data = await response.json();

      if (response.ok) {
        setPreviewUrl(data.accessUrl);
        setPreviewInstanceId(data.instanceId);
        setLogs(
          (prev) =>
            `${prev}\n[INFO] Prévisualisation créée avec succès: ${data.accessUrl}`
        );
        setShowPreview(true);
      } else {
        setLogs(
          (prev) =>
            `${prev}\n[ERROR] Échec de la création de la prévisualisation: ${data.error}`
        );
      }
    } catch (error) {
      setLogs(
        (prev) =>
          `${prev}\n[ERROR] Erreur lors de la création de la prévisualisation: ${error.message}`
      );
    } finally {
      setIsLoadingPreview(false);
    }
  };

  // Nouvelle fonction pour fermer la prévisualisation
  const closePreview = async () => {
    if (!previewInstanceId || !sandboxId) return;

    try {
      setLogs((prev) => `${prev}\n[INFO] Fermeture de la prévisualisation...`);

      await fetch(
        `${apiBaseUrl}/sandboxes/${sandboxId}/preview/${previewInstanceId}`,
        {
          method: "DELETE",
        }
      );

      setPreviewUrl(null);
      setPreviewInstanceId(null);
      setShowPreview(false);
      setLogs((prev) => `${prev}\n[INFO] Prévisualisation fermée avec succès`);
    } catch (error) {
      setLogs(
        (prev) =>
          `${prev}\n[ERROR] Erreur lors de la fermeture de la prévisualisation: ${error.message}`
      );
    }
  };

  return (
    <div className="bg-background border rounded-md p-2 mt-4">
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-lg font-medium text-text-primary">
          Application Logs{" "}
          {connected ? (
            <span className="text-green-500 text-sm">(Connected)</span>
          ) : (
            <span className="text-red-500 text-sm">(Disconnected)</span>
          )}
        </h3>
        <div className="flex gap-2">
          {/* Bouton de redémarrage */}
          <button
            onClick={handleRestart}
            disabled={isRestarting || !sandboxId}
            className={`text-sm px-3 py-1 rounded ${
              isRestarting
                ? "bg-gray-300 cursor-not-allowed"
                : "bg-blue-500 hover:bg-blue-600 text-white"
            }`}
          >
            {isRestarting ? "Redémarrage..." : "Redémarrer"}
          </button>

          {/* Bouton pour exposer le port 3000 et afficher le preview */}
          <button
            onClick={() => exposeContainerPort(3000)}
            disabled={isExposing || !sandboxId}
            className={`text-sm px-3 py-1 rounded ${
              isExposing
                ? "bg-gray-300 cursor-not-allowed"
                : "bg-purple-500 hover:bg-purple-600 text-white"
            }`}
          >
            {isExposing ? "Exposition..." : "Afficher Preview"}
          </button>

          {/* Nouveau bouton pour créer une prévisualisation */}
          <button
            onClick={() => createPreview(3000)}
            disabled={isLoadingPreview || !sandboxId || !!previewUrl}
            className={`text-sm px-3 py-1 rounded ${
              isLoadingPreview || !!previewUrl
                ? "bg-gray-300 cursor-not-allowed"
                : "bg-teal-500 hover:bg-teal-600 text-white"
            }`}
          >
            {isLoadingPreview ? "Chargement..." : "Nouvelle Prévisualisation"}
          </button>

          {/* Bouton pour fermer la prévisualisation */}
          {previewUrl && (
            <button
              onClick={closePreview}
              className="text-sm px-3 py-1 rounded bg-red-500 hover:bg-red-600 text-white"
            >
              Fermer Prévisualisation
            </button>
          )}

          {/* Bouton pour basculer l'affichage du preview */}
          {exposedUrl && (
            <button
              onClick={togglePreview}
              className={`text-sm px-3 py-1 rounded ${
                showPreview
                  ? "bg-red-500 hover:bg-red-600 text-white"
                  : "bg-green-500 hover:bg-green-600 text-white"
              }`}
            >
              {showPreview ? "Masquer Preview" : "Afficher Preview"}
            </button>
          )}

          {/* Lien pour ouvrir dans un nouvel onglet */}
          {(exposedUrl || previewUrl) && (
            <a
              href={previewUrl || exposedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm px-3 py-1 bg-teal-500 hover:bg-teal-600 text-white rounded"
            >
              Ouvrir dans un nouvel onglet
            </a>
          )}

          <label className="flex items-center text-sm">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="mr-1"
            />
            Auto-scroll
          </label>
          <button
            onClick={clearLogs}
            className="text-sm px-2 py-1 bg-gray-200 hover:bg-gray-300 rounded"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Preview de l'application dans une iframe (ancienne méthode) */}
      {showPreview && exposedUrl && !previewUrl && (
        <div className="mb-4">
          <div
            className="border rounded overflow-hidden"
            style={{ height: "500px" }}
          >
            <iframe
              src={exposedUrl}
              title="Application Preview"
              className="w-full h-full border-0"
              sandbox="allow-same-origin allow-scripts allow-forms"
              loading="lazy"
            />
          </div>
          <div className="text-right mt-1">
            <span className="text-sm text-gray-500">
              Preview URL:{" "}
              <a
                href={exposedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:underline"
              >
                {exposedUrl}
              </a>
            </span>
          </div>
        </div>
      )}

      {/* Nouvelle prévisualisation dans une iframe */}
      {showPreview && previewUrl && (
        <div className="mb-4">
          <div
            className="border rounded overflow-hidden"
            style={{ height: "500px" }}
          >
            <iframe
              src={previewUrl}
              title="Application Preview"
              className="w-full h-full border-0"
              sandbox="allow-same-origin allow-scripts allow-forms"
              loading="lazy"
            />
          </div>
          <div className="text-right mt-1">
            <span className="text-sm text-gray-500">
              Preview URL:{" "}
              <a
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:underline"
              >
                {previewUrl}
              </a>
            </span>
          </div>
        </div>
      )}

      <div
        ref={logContainerRef}
        className="bg-black text-white font-mono text-sm p-2 rounded h-64 overflow-y-auto whitespace-pre-wrap"
      >
        {logs.length === 0 ? (
          <div className="text-gray-400 italic">No logs yet...</div>
        ) : (
          logs
        )}
      </div>
    </div>
  );
};

export default LogViewer;
