const express = require("express");
const { exec } = require("child_process");
const app = express();
const port = 3000;

app.use(express.json());

// Liste des sandboxes actives
const activeSandboxes = {};

// Endpoint pour créer un nouveau sandbox
app.post("/sandboxes", (req, res) => {
  const { userId, template = "node" } = req.body;
  const sandboxId = `sandbox-${userId}-${Date.now()}`;

  console.log(`Creating sandbox ${sandboxId} for user ${userId}`);

  // Créer un conteneur Podman isolé
  const cmd = `podman run -d --name ${sandboxId} --memory=512m --cpus=0.5 node:18-slim tail -f /dev/null`;

  exec(cmd, (error, stdout) => {
    if (error) {
      console.error(`Error creating sandbox: ${error}`);
      return res.status(500).json({ error: "Failed to create sandbox" });
    }

    const containerId = stdout.trim();
    activeSandboxes[sandboxId] = {
      containerId,
      userId,
      createdAt: new Date(),
      status: "running",
    };

    res.json({
      sandboxId,
      containerId,
      status: "running",
    });
  });
});

// Endpoint pour exécuter du code dans un sandbox
app.post("/sandboxes/:sandboxId/execute", (req, res) => {
  const { sandboxId } = req.params;
  const { code } = req.body;

  if (!activeSandboxes[sandboxId]) {
    return res.status(404).json({ error: "Sandbox not found" });
  }

  // Écrire le code dans un fichier temporaire dans le conteneur
  const codeEscaped = code.replace(/'/g, "'\\''");
  const cmd = `podman exec ${sandboxId} bash -c 'echo "${codeEscaped}" > /tmp/code.js && node /tmp/code.js'`;

  exec(cmd, (error, stdout, stderr) => {
    res.json({
      output: stdout,
      error: stderr,
      exitCode: error ? error.code : 0,
    });
  });
});

// Endpoint pour arrêter un sandbox
app.delete("/sandboxes/:sandboxId", (req, res) => {
  const { sandboxId } = req.params;

  if (!activeSandboxes[sandboxId]) {
    return res.status(404).json({ error: "Sandbox not found" });
  }

  exec(`podman stop ${sandboxId} && podman rm ${sandboxId}`, (error) => {
    if (error) {
      return res.status(500).json({ error: "Failed to stop sandbox" });
    }

    delete activeSandboxes[sandboxId];
    res.json({ success: true });
  });
});

// Endpoint pour lister les sandboxes
app.get("/sandboxes", (req, res) => {
  res.json(activeSandboxes);
});

app.listen(port, () => {
  console.log(`Sandbox API running on port ${port}`);
});
