"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import { getCurrentUserTenant, parseAPI } from "@/lib/parse-client";
import Editor from "@monaco-editor/react";
import LogViewer from "@/components/LogViewer";

export default function TenantDashboard() {
  // State hooks
  const [tenant, setTenant] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sandboxes, setSandboxes] = useState([]);
  const [activeSandbox, setActiveSandbox] = useState(null);
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [isCloning, setIsCloning] = useState(false);
  const [notification, setNotification] = useState(null);
  const [currentProcessId, setCurrentProcessId] = useState(null);

  // Refs and router
  const editorRef = useRef(null);
  const router = useRouter();
  const params = useParams();
  const tenantId = params.tenantId;

  // API base URL - should be moved to environment variables in production
  const API_BASE_URL =
    process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

  // Fetch tenant data and sandboxes on component mount
  useEffect(() => {
    fetchTenantData();
  }, [tenantId]);

  // Fetch tenant data and validate user access
  const fetchTenantData = async () => {
    try {
      // Check if user is logged in
      const userJson = localStorage.getItem("user");
      if (!userJson) {
        router.push("/login");
        return;
      }

      const user = JSON.parse(userJson);
      const sessionToken = localStorage.getItem("sessionToken");

      // Verify that the user has access to this tenant
      if (user.tenantId !== tenantId) {
        setError("You do not have access to this tenant");
        setLoading(false);
        return;
      }

      // Fetch tenant details
      const tenantData = await getCurrentUserTenant(user.userId, sessionToken);

      if (tenantData.success) {
        setTenant(tenantData);
        await fetchSandboxes();
      } else {
        setError(tenantData.error || "Failed to load tenant data");
      }
    } catch (error) {
      setError(error.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  // Fetch sandboxes for the current tenant
  const fetchSandboxes = async () => {
    try {
      const sandboxesData = await parseAPI.getSandboxes(tenantId);
      setSandboxes(sandboxesData);
    } catch (error) {
      console.error("Failed to load sandboxes:", error);
      showNotification(`Error loading sandboxes: ${error.message}`, "error");
    }
  };

  // Handle user logout
  const handleLogout = () => {
    localStorage.removeItem("user");
    localStorage.removeItem("sessionToken");
    router.push("/login");
  };

  // Store editor reference when mounted
  const handleEditorDidMount = (editor) => {
    editorRef.current = editor;
  };

  // Handle sandbox selection and fetch its files
  const handleSandboxSelect = async (sandboxId) => {
    setActiveSandbox(sandboxId);
    setSelectedFile(null);
    setFileContent("");

    try {
      const response = await fetch(
        `${API_BASE_URL}/sandboxes/${sandboxId}/files`
      );
      const data = await response.json();

      if (data.success) {
        setFiles(data.files);
        showNotification(
          `Loaded ${data.files.length} files from sandbox`,
          "success"
        );
      } else {
        showNotification(`Error loading files: ${data.error}`, "error");
      }
    } catch (error) {
      showNotification(`Error: ${error.message}`, "error");
    }
  };

  // Handle file selection and fetch its content
  const handleFileSelect = async (filePath) => {
    if (!activeSandbox) return;

    try {
      const response = await fetch(
        `${API_BASE_URL}/sandboxes/${activeSandbox}/files/content?path=${encodeURIComponent(
          filePath
        )}`
      );
      const data = await response.json();

      if (data.success) {
        setSelectedFile(filePath);
        setFileContent(data.content);
      } else {
        showNotification(`Error loading file: ${data.error}`, "error");
      }
    } catch (error) {
      showNotification(`Error: ${error.message}`, "error");
    }
  };

  // Save file content
  const handleSaveFile = async () => {
    if (!activeSandbox || !selectedFile || !editorRef.current) return;

    try {
      const content = editorRef.current.getValue();

      const response = await fetch(
        `${API_BASE_URL}/sandboxes/${activeSandbox}/files/content`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            path: selectedFile,
            content: content,
          }),
        }
      );

      const data = await response.json();

      if (data.success) {
        showNotification(`File saved successfully`, "success");
      } else {
        showNotification(`Error saving file: ${data.error}`, "error");
      }
    } catch (error) {
      showNotification(`Error: ${error.message}`, "error");
    }
  };

  // Clone git repository into sandbox
  const handleCloneRepo = async () => {
    if (!activeSandbox || !repoUrl) return;

    setIsCloning(true);

    try {
      const response = await fetch(
        `${API_BASE_URL}/sandboxes/${activeSandbox}/clone`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            repoUrl: repoUrl,
          }),
        }
      );

      const data = await response.json();

      if (data.success) {
        showNotification(`Repository cloned successfully`, "success");
        // Refresh file list
        handleSandboxSelect(activeSandbox);
        // Clear repo URL field
        setRepoUrl("");
      } else {
        showNotification(`Error cloning repository: ${data.error}`, "error");
      }
    } catch (error) {
      showNotification(`Error: ${error.message}`, "error");
    } finally {
      setIsCloning(false);
    }
  };

  // Fonction pour installer et lancer l'application
  const handleInstallAndStart = async () => {
    if (!activeSandbox) return;

    try {
      setIsCloning(true); // Réutilisation de l'état pour montrer le chargement

      const response = await fetch(
        `${API_BASE_URL}/sandboxes/${activeSandbox}/install-and-start`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            command: "npm run dev", // Commande à exécuter après l'installation
            cwd: "/sandbox/repo",
          }),
        }
      );

      const data = await response.json();

      if (data.success) {
        showNotification(
          `Installation et démarrage de l'application en cours`,
          "success"
        );

        // Stocker l'ID du processus pour la récupération des logs
        setCurrentProcessId(data.processId);

        // Connecter au socket pour recevoir les logs
        if (socket) {
          socket.emit("join-sandbox", activeSandbox);
        }
      } else {
        showNotification(`Erreur: ${data.error}`, "error");
      }
    } catch (error) {
      showNotification(`Erreur: ${error.message}`, "error");
    } finally {
      setIsCloning(false);
    }
  };

  // Display notification
  const showNotification = (message, type) => {
    setNotification({ message, type });
    // Auto-dismiss after 5 seconds
    setTimeout(() => setNotification(null), 5000);
  };

  // Create a new sandbox
  const createNewSandbox = async () => {
    try {
      const userJson = localStorage.getItem("user");
      if (!userJson) {
        showNotification(
          "User information not found. Please login again.",
          "error"
        );
        return;
      }

      const user = JSON.parse(userJson);

      const response = await fetch(
        `${API_BASE_URL}/tenants/${tenantId}/sandboxes`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId: user.userId,
            template: "node",
          }),
        }
      );

      const data = await response.json();

      if (response.ok) {
        showNotification(`Sandbox created: ${data.sandboxId}`, "success");
        // Refresh sandboxes
        await fetchSandboxes();
      } else {
        showNotification(`Error creating sandbox: ${data.error}`, "error");
      }
    } catch (error) {
      showNotification(`Error: ${error.message}`, "error");
    }
  };

  // Render loading state
  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-4 bg-background">
        <div className="card p-8 text-center">
          <div className="text-xl text-text-primary font-semibold">
            Loading tenant data...
          </div>
          <div className="mt-4 w-12 h-12 border-t-4 border-primary rounded-full animate-spin mx-auto"></div>
        </div>
      </div>
    );
  }

  // Render error state
  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-4 bg-background">
        <div className="card p-8 max-w-md w-full">
          <div className="notification notification-error mb-4" role="alert">
            <span className="block sm:inline">{error}</span>
          </div>
          <button
            onClick={() => router.push("/login")}
            className="btn btn-primary w-full"
          >
            Back to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-card-background shadow">
        <div className="max-w-7xl mx-auto py-4 px-4 sm:px-6 lg:px-8 flex justify-between items-center">
          <h1 className="text-3xl font-bold text-text-primary">
            Tenant Dashboard
          </h1>
          <button onClick={handleLogout} className="btn btn-danger">
            Logout
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        {/* Tenant Information Section */}
        <section className="px-4 py-6 sm:px-0 mb-6">
          <div className="card">
            <h2 className="text-2xl font-semibold mb-4 text-text-primary">
              Tenant Information
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-background p-4 rounded">
                <h3 className="text-lg font-medium text-text-primary">
                  Tenant ID
                </h3>
                <p className="text-text-secondary">{tenant?.tenantId}</p>
              </div>

              <div className="bg-background p-4 rounded">
                <h3 className="text-lg font-medium text-text-primary">Plan</h3>
                <p className="text-text-secondary capitalize">{tenant?.plan}</p>
              </div>

              <div className="bg-background p-4 rounded">
                <h3 className="text-lg font-medium text-text-primary">
                  Status
                </h3>
                <p className="text-text-secondary capitalize">
                  {tenant?.status}
                </p>
              </div>

              <div className="bg-background p-4 rounded">
                <h3 className="text-lg font-medium text-text-primary">
                  Resources
                </h3>
                <ul className="list-disc list-inside text-text-secondary">
                  <li>Memory: {tenant?.resources?.memory || "N/A"}</li>
                  <li>CPUs: {tenant?.resources?.cpus || "N/A"}</li>
                  <li>Containers: {tenant?.resources?.containers || "N/A"}</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Sandboxes and Code Editor Section */}
        <section className="px-4 sm:px-0">
          <div className="card">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-2xl font-semibold text-text-primary">
                Sandboxes
              </h2>
              <button onClick={createNewSandbox} className="btn btn-success">
                Create New Sandbox
              </button>
            </div>

            {/* Sandboxes List */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              {sandboxes.length === 0 ? (
                <div className="col-span-3 text-center py-8 bg-background rounded text-text-secondary">
                  No sandboxes available. Create one to get started.
                </div>
              ) : (
                sandboxes.map((sandbox) => (
                  <div
                    key={sandbox.id}
                    className={`p-4 rounded cursor-pointer transition-all ${
                      activeSandbox === sandbox.sandboxId
                        ? "bg-primary bg-opacity-10 border-2 border-primary"
                        : "bg-background hover:bg-primary hover:bg-opacity-5 border-2 border-transparent"
                    }`}
                    onClick={() => handleSandboxSelect(sandbox.sandboxId)}
                  >
                    <h3 className="font-medium text-text-primary">
                      {sandbox.sandboxId}
                    </h3>
                    <p className="text-sm text-text-muted">
                      Status:{" "}
                      <span className="text-text-secondary">
                        {sandbox.status}
                      </span>
                    </p>
                    <p className="text-sm text-text-muted">
                      Created:{" "}
                      <span className="text-text-secondary">
                        {new Date(sandbox.createdAt).toLocaleString()}
                      </span>
                    </p>
                  </div>
                ))
              )}
            </div>

            {/* Repository Clone Section */}
            {activeSandbox && (
              <div className="mb-6 p-4 bg-background rounded">
                <h3 className="text-lg font-medium mb-2 text-text-primary">
                  Clone Repository
                </h3>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    placeholder="Enter Git repository URL"
                    className="flex-1 p-2 border rounded"
                  />
                  <button
                    onClick={handleCloneRepo}
                    disabled={isCloning || !repoUrl}
                    className={`btn ${
                      isCloning || !repoUrl
                        ? "bg-text-muted cursor-not-allowed"
                        : "btn-secondary"
                    }`}
                  >
                    {isCloning ? "Cloning..." : "Clone"}
                  </button>
                </div>
              </div>
            )}

            {/* File Explorer and Editor */}
            {activeSandbox && (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {/* File Explorer */}
                <div className="bg-background p-4 rounded h-[600px] overflow-auto">
                  <h3 className="text-lg font-medium mb-2 text-text-primary">
                    Files
                  </h3>
                  {files.length === 0 ? (
                    <p className="text-text-muted">No files available</p>
                  ) : (
                    <ul className="space-y-1">
                      {files.map((file, index) => (
                        <li
                          key={index}
                          className={`p-2 text-sm rounded cursor-pointer truncate ${
                            selectedFile === file
                              ? "bg-primary bg-opacity-10 text-primary"
                              : "hover:bg-primary hover:bg-opacity-5 text-text-secondary"
                          }`}
                          onClick={() => handleFileSelect(file)}
                          title={file}
                        >
                          {file.split("/").pop()}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Code Editor */}
                <div className="col-span-3">
                  <div className="flex justify-between items-center mb-2">
                    <h3 className="text-lg font-medium text-text-primary">
                      {selectedFile ? selectedFile.split("/").pop() : "Editor"}
                    </h3>
                    {selectedFile && (
                      <button
                        onClick={handleSaveFile}
                        className="btn btn-primary py-1 px-4 text-sm"
                      >
                        Save
                      </button>
                    )}
                  </div>
                  <div className="border border-card-border rounded h-[600px] overflow-hidden">
                    <Editor
                      height="100%"
                      defaultLanguage="javascript"
                      value={fileContent}
                      theme="vs-dark"
                      onMount={handleEditorDidMount}
                      options={{
                        readOnly: !selectedFile,
                        minimap: { enabled: true },
                        scrollBeyondLastLine: false,
                        fontSize: 14,
                        fontFamily: "var(--font-mono), monospace",
                      }}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Installer et lancer l'application */}
            <div className="mt-2">
              <button
                onClick={handleInstallAndStart}
                disabled={isCloning}
                className={`btn ${
                  isCloning ? "bg-text-muted cursor-not-allowed" : "btn-primary"
                }`}
              >
                {isCloning
                  ? "Installation et démarrage..."
                  : "Installer et lancer l'application"}
              </button>
            </div>

            {/* Log Viewer */}
            {activeSandbox && (
              <LogViewer
                sandboxId={activeSandbox}
                apiBaseUrl={API_BASE_URL}
                processId={currentProcessId}
              />
            )}
          </div>
        </section>
      </main>

      {/* Notification */}
      {notification && (
        <div
          className={`fixed bottom-4 right-4 p-4 rounded shadow-lg ${
            notification.type === "success"
              ? "notification-success"
              : "notification-error"
          } text-white max-w-md z-50`}
        >
          {notification.message}
        </div>
      )}
    </div>
  );
}
