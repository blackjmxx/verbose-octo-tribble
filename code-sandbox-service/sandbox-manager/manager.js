const express = require("express");
const { exec, spawn } = require("child_process");
const app = express();
const port = 3001;
const fs = require("fs");
const path = require("path");
const os = require("os");
const Parse = require("parse/node");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

// Créer un serveur HTTP à partir de l'application Express
const server = http.createServer(app);

// Initialiser Socket.IO avec CORS
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST"],
  },
});

// Map pour stocker les processus par sandboxId
const sandboxProcesses = new Map();

// Créer un répertoire pour les logs s'il n'existe pas
const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Map pour stocker les informations sur les processus en cours
const runningProcesses = new Map();

// Enable CORS for all routes
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());

// Initialize Parse
Parse.initialize(
  process.env.PARSE_APP_ID || "myAppId",
  process.env.PARSE_JS_KEY || "masterKey",
  process.env.PARSE_MASTER_KEY || "masterKey"
);
Parse.serverURL = process.env.PARSE_SERVER_URL || "http://localhost:1337/parse";
Parse.javaScriptKey = process.env.PARSE_JS_KEY || "masterKey";

// Simple in-memory database for tenants (in production, use a real DB)
const tenants = {};

// Parse class for Tenant
const Tenant = Parse.Object.extend("Tenant");
const Sandbox = Parse.Object.extend("Sandbox");

// Endpoint to create a new tenant
app.post("/tenants", async (req, res) => {
  const { tenantId, plan = "basic", email, password } = req.body;
  const podName = `tenant-${tenantId}`;

  // Check if tenant already exists in our application
  if (tenants[tenantId]) {
    return res.status(400).json({ error: "Tenant already exists" });
  }

  // Define resource limits based on plan
  const resources =
    {
      basic: { memory: "512m", cpus: 0.5, containers: 10 },
      pro: { memory: "1g", cpus: 1, containers: 10 },
      business: { memory: "2g", cpus: 2, containers: 20 },
    }[plan] || resources.basic;

  try {
    // Create Parse user if email and password are provided
    let user;
    if (email && password) {
      user = new Parse.User();
      user.set("username", email);
      user.set("email", email);
      user.set("password", password);
      user.set("tenantId", tenantId);
      await user.signUp();
    }

    // Check if pod already exists in Podman
    exec(`podman pod exists ${podName}`, async (existsError) => {
      if (!existsError) {
        console.log(`Pod ${podName} already exists, reusing it`);

        // Pod already exists, add it to our application
        tenants[tenantId] = {
          podName,
          plan,
          resources,
          createdAt: new Date(),
          sandboxes: {},
        };

        // Save tenant to Parse
        const tenant = new Tenant();
        tenant.set("tenantId", tenantId);
        tenant.set("podName", podName);
        tenant.set("plan", plan);
        tenant.set("resources", resources);
        tenant.set("status", "reused");
        if (user) tenant.set("user", user);
        await tenant.save();

        return res.json({
          tenantId,
          podName,
          plan,
          resources,
          status: "reused",
        });
      }

      const externalPort = 8081;

      // Pod doesn't exist, create it
      const podCmd = `podman pod create --name ${podName} -p ${externalPort}:3000 -p 8080:8080 -p 5000:5000`;
      console.log(`Executing command: ${podCmd}`);

      exec(podCmd, async (error, stdout, stderr) => {
        if (error) {
          console.error(`Error creating pod: ${error}`);
          console.error(`stderr: ${stderr}`);
          return res
            .status(500)
            .json({ error: "Failed to create tenant", details: stderr });
        }

        console.log(`Pod created successfully: ${stdout}`);

        tenants[tenantId] = {
          podName,
          plan,
          resources,
          createdAt: new Date(),
          sandboxes: {},
        };

        // Save tenant to Parse
        const tenant = new Tenant();
        tenant.set("tenantId", tenantId);
        tenant.set("podName", podName);
        tenant.set("plan", plan);
        tenant.set("resources", resources);
        tenant.set("status", "created");
        if (user) tenant.set("user", user);
        await tenant.save();

        res.json({
          tenantId,
          podName,
          plan,
          resources,
          status: "created",
        });
      });
    });
  } catch (error) {
    console.error(`Error creating tenant in Parse: ${error}`);
    return res.status(500).json({
      error: "Failed to create tenant account",
      details: error.message,
    });
  }
});

// Endpoint to create a sandbox for a tenant
app.post("/tenants/:tenantId/sandboxes", async (req, res) => {
  const { tenantId } = req.params;
  const { userId, template = "node" } = req.body;

  if (!tenants[tenantId]) {
    return res.status(404).json({ error: "Tenant not found" });
  }

  const tenant = tenants[tenantId];
  const sandboxCount = Object.keys(tenant.sandboxes).length - 3;

  if (sandboxCount >= tenant.resources.containers) {
    return res
      .status(429)
      .json({ error: "Maximum number of sandboxes reached for this tenant" });
  }

  const sandboxId = `${tenantId}-${userId}-${Date.now()}`;
  const podName = tenant.podName;

  // Utiliser une image personnalisée avec Git préinstallé
  const baseImage =
    process.env.SANDBOX_IMAGE || "localhost/node:20-slim-with-git";

  const externalPort = 8081;
  // Ajouter des options pour publier les ports courants
  const containerCmd = `podman run -d --pod ${podName} --name ${sandboxId} -p ${externalPort}:3000 --memory=${tenant.resources.memory} --cpus=${tenant.resources.cpus} ${baseImage} tail -f /dev/null`;

  exec(containerCmd, async (error, stdout) => {
    if (error) {
      console.error(`Error creating sandbox: ${error}`);
      return res.status(500).json({ error: "Failed to create sandbox" });
    }

    const containerId = stdout.trim();
    tenant.sandboxes[sandboxId] = {
      containerId,
      userId,
      createdAt: new Date(),
      status: "running",
    };

    try {
      // Save sandbox to Parse
      const sandbox = new Sandbox();
      sandbox.set("sandboxId", sandboxId);
      sandbox.set("containerId", containerId);
      sandbox.set("tenantId", tenantId);
      sandbox.set("userId", userId);
      sandbox.set("status", "running");
      sandbox.set("template", template);

      // Query for the tenant in Parse
      const query = new Parse.Query(Tenant);
      query.equalTo("tenantId", tenantId);
      const tenantObject = await query.first();
      if (tenantObject) {
        sandbox.set("tenant", tenantObject);
      }

      await sandbox.save();

      res.json({
        sandboxId,
        containerId,
        status: "running",
      });
    } catch (parseError) {
      console.error(`Error saving sandbox to Parse: ${parseError}`);
      // We still return success since the container was created
      res.json({
        sandboxId,
        containerId,
        status: "running",
        parseError: parseError.message,
      });
    }
  });
});

// Endpoint to execute code in a sandbox
app.post(
  "/tenants/:tenantId/sandboxes/:sandboxId/execute",
  async (req, res) => {
    const { tenantId, sandboxId } = req.params;
    const { code } = req.body;

    if (!tenants[tenantId] || !tenants[tenantId].sandboxes[sandboxId]) {
      return res.status(404).json({ error: "Sandbox not found" });
    }

    // Create a local temporary file
    const tempFile = path.join(os.tmpdir(), `code-${Date.now()}.js`);
    fs.writeFileSync(tempFile, code);

    // Copy the file to the container and execute it
    const cmd = `podman cp ${tempFile} ${sandboxId}:/tmp/code.js && podman exec ${sandboxId} node /tmp/code.js`;

    exec(cmd, async (error, stdout, stderr) => {
      // Delete the temporary file
      fs.unlinkSync(tempFile);

      try {
        // Save execution result to Parse
        const query = new Parse.Query(Sandbox);
        query.equalTo("sandboxId", sandboxId);
        const sandbox = await query.first();

        if (sandbox) {
          // Create an Execution object
          const Execution = Parse.Object.extend("Execution");
          const execution = new Execution();

          execution.set("sandbox", sandbox);
          execution.set("code", code);
          execution.set("output", stdout);
          execution.set("error", stderr);
          execution.set("exitCode", error ? error.code : 0);
          execution.set("executedAt", new Date());

          await execution.save();
        }
      } catch (parseError) {
        console.error(`Error saving execution to Parse: ${parseError}`);
        // Continue to return the result even if Parse save fails
      }

      res.json({
        output: stdout,
        error: stderr,
        exitCode: error ? error.code : 0,
      });
    });
  }
);

// Endpoint to list tenants
app.get("/tenants", async (req, res) => {
  try {
    // Get tenants from Parse
    const query = new Parse.Query(Tenant);
    const parseResults = await query.find();

    // Combine in-memory tenants with Parse results
    const parseTenants = parseResults.map((tenant) => tenant.toJSON());

    res.json({
      memoryTenants: tenants,
      parseTenants: parseTenants,
    });
  } catch (error) {
    console.error(`Error fetching tenants from Parse: ${error}`);
    res.json(tenants);
  }
});

// Endpoint to get tenant details
app.get("/tenants/:tenantId", async (req, res) => {
  const { tenantId } = req.params;

  if (!tenants[tenantId]) {
    return res.status(404).json({ error: "Tenant not found" });
  }

  try {
    // Get tenant from Parse
    const query = new Parse.Query(Tenant);
    query.equalTo("tenantId", tenantId);
    const tenant = await query.first();

    if (tenant) {
      // Get sandboxes for this tenant
      const sandboxQuery = new Parse.Query(Sandbox);
      sandboxQuery.equalTo("tenantId", tenantId);
      const sandboxes = await sandboxQuery.find();

      res.json({
        ...tenants[tenantId],
        parseData: tenant.toJSON(),
        parseSandboxes: sandboxes.map((sandbox) => sandbox.toJSON()),
      });
    } else {
      res.json(tenants[tenantId]);
    }
  } catch (error) {
    console.error(`Error fetching tenant from Parse: ${error}`);
    res.json(tenants[tenantId]);
  }
});

// Endpoint to list existing Podman pods
app.get("/debug/pods", (req, res) => {
  exec("podman pod ls --format json", (error, stdout, stderr) => {
    if (error) {
      console.error(`Error listing pods: ${error}`);
      return res
        .status(500)
        .json({ error: "Failed to list pods", details: stderr });
    }

    try {
      const pods = JSON.parse(stdout);
      res.json(pods);
    } catch (e) {
      res
        .status(500)
        .json({ error: "Failed to parse pod list", stdout, stderr });
    }
  });
});

// Endpoint for debug to create a container directly
app.post("/debug/container", (req, res) => {
  const { name } = req.body;
  const containerId = name || `debug-container-${Date.now()}`;

  // Utiliser la même image personnalisée
  const baseImage = process.env.SANDBOX_IMAGE || "node:18-slim-with-git";

  const cmd = `podman run -d --name ${containerId} ${baseImage} tail -f /dev/null`;
  console.log(`Executing command: ${cmd}`);

  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error creating container: ${error}`);
      console.error(`stderr: ${stderr}`);
      return res
        .status(500)
        .json({ error: "Failed to create container", details: stderr });
    }

    console.log(`Container created successfully: ${stdout}`);
    res.json({ containerId: stdout.trim(), command: cmd });
  });
});

// Endpoint to delete a tenant
app.delete("/tenants/:tenantId", async (req, res) => {
  const { tenantId } = req.params;
  const { force = false } = req.query;

  if (!tenants[tenantId]) {
    return res.status(404).json({ error: "Tenant not found" });
  }

  const podName = tenants[tenantId].podName;
  const forceFlag = force === "true" ? " -f" : "";

  exec(
    `podman pod rm${forceFlag} ${podName}`,
    async (error, stdout, stderr) => {
      if (error) {
        console.error(`Error removing pod: ${error}`);
        console.error(`stderr: ${stderr}`);
        return res
          .status(500)
          .json({ error: "Failed to remove tenant", details: stderr });
      }

      console.log(`Pod removed successfully: ${stdout}`);

      try {
        // Delete tenant from Parse
        const query = new Parse.Query(Tenant);
        query.equalTo("tenantId", tenantId);
        const tenant = await query.first();

        if (tenant) {
          await tenant.destroy();
        }

        // Delete associated sandboxes
        const sandboxQuery = new Parse.Query(Sandbox);
        sandboxQuery.equalTo("tenantId", tenantId);
        const sandboxes = await sandboxQuery.find();

        for (const sandbox of sandboxes) {
          await sandbox.destroy();
        }
      } catch (parseError) {
        console.error(`Error deleting tenant from Parse: ${parseError}`);
        // Continue with the deletion even if Parse delete fails
      }

      delete tenants[tenantId];

      res.json({ message: `Tenant ${tenantId} removed successfully` });
    }
  );
});

// Function to synchronize existing containers in a pod
async function syncExistingContainers(tenantId, podName) {
  console.log(`Synchronizing existing containers for tenant ${tenantId}...`);

  exec(`podman ps -a --format json`, async (error, stdout, stderr) => {
    if (error) {
      console.error(`Error listing containers: ${error}`);
      console.error(`stderr: ${stderr}`);
      return;
    }

    try {
      const containers = JSON.parse(stdout);
      console.log(`Found ${containers.length} total containers`);

      // Filter containers that belong to the pod and are not infrastructure containers
      const sandboxContainers = containers.filter(
        (container) => container.PodName === podName && !container.IsInfra
      );

      console.log(
        `Found ${sandboxContainers.length} sandbox containers for tenant ${tenantId}`
      );

      // Add each container as a sandbox
      for (const container of sandboxContainers) {
        const sandboxId = container.Names[0];

        console.log(`Processing container: ${JSON.stringify(container.Names)}`);

        // Check if this sandbox already exists
        if (!tenants[tenantId].sandboxes[sandboxId]) {
          console.log(
            `Adding existing sandbox ${sandboxId} to tenant ${tenantId}`
          );

          const sandboxData = {
            containerId: container.Id,
            userId: sandboxId.split("-")[1] || "unknown",
            createdAt: new Date(container.Created * 1000),
            status:
              container.State.toLowerCase() === "running"
                ? "running"
                : "stopped",
          };

          tenants[tenantId].sandboxes[sandboxId] = sandboxData;

          // Save to Parse
          try {
            const sandbox = new Sandbox();
            sandbox.set("sandboxId", sandboxId);
            sandbox.set("containerId", container.Id);
            sandbox.set("tenantId", tenantId);
            sandbox.set("userId", sandboxData.userId);
            sandbox.set("status", sandboxData.status);

            // Query for the tenant in Parse
            const query = new Parse.Query(Tenant);
            query.equalTo("tenantId", tenantId);
            const tenantObject = await query.first();
            if (tenantObject) {
              sandbox.set("tenant", tenantObject);
            }

            await sandbox.save();
          } catch (parseError) {
            console.error(`Error saving sandbox to Parse: ${parseError}`);
          }
        }
      }

      console.log(
        `Synchronized ${
          Object.keys(tenants[tenantId].sandboxes).length
        } sandboxes for tenant ${tenantId}`
      );
    } catch (e) {
      console.error(`Error parsing container list: ${e.message}`);
      console.error(e.stack);
    }
  });
}

// Function to synchronize existing pods with the application
async function syncExistingPods() {
  console.log("Synchronizing existing pods with application...");

  // Use text format instead of JSON
  exec("podman pod ls", async (error, stdout, stderr) => {
    if (error) {
      console.error(`Error listing pods: ${error}`);
      console.error(`stderr: ${stderr}`);
      return;
    }

    try {
      // Parse text output
      const lines = stdout.trim().split("\n");
      // Skip the first line (headers)
      const podLines = lines.slice(1);

      console.log(`Found ${podLines.length} pods`);

      for (const line of podLines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const podName = parts[1]; // Pod name is usually in the second column

          if (podName && podName.startsWith("tenant-")) {
            const tenantId = podName.replace("tenant-", "");
            console.log(
              `Found existing tenant pod: ${podName} for tenant ${tenantId}`
            );

            // Add tenant if it doesn't already exist
            if (!tenants[tenantId]) {
              tenants[tenantId] = {
                podName,
                plan: "basic", // Default plan
                resources: { memory: "512m", cpus: 0.5, containers: 10 },
                createdAt: new Date(),
                sandboxes: {},
              };

              // Check if tenant exists in Parse
              try {
                const query = new Parse.Query(Tenant);
                query.equalTo("tenantId", tenantId);
                let tenant = await query.first();

                if (!tenant) {
                  // Create tenant in Parse if it doesn't exist
                  tenant = new Tenant();
                  tenant.set("tenantId", tenantId);
                  tenant.set("podName", podName);
                  tenant.set("plan", "basic");
                  tenant.set("resources", {
                    memory: "512m",
                    cpus: 0.5,
                    containers: 10,
                  });
                  tenant.set("status", "synced");
                  await tenant.save();
                }
              } catch (parseError) {
                console.error(`Error syncing tenant to Parse: ${parseError}`);
              }

              // Synchronize existing containers for this tenant
              syncExistingContainers(tenantId, podName);
            }
          }
        }
      }

      console.log(`Synchronized ${Object.keys(tenants).length} tenants`);
    } catch (e) {
      console.error(`Error parsing pod list: ${e.message}`);
    }
  });
}

// Call the function at startup
syncExistingPods();

// Endpoint to execute a Podman command directly
app.post("/debug/exec", (req, res) => {
  const { command } = req.body;

  if (!command) {
    return res.status(400).json({ error: "Command is required" });
  }

  console.log(`Executing command: ${command}`);

  exec(command, (error, stdout, stderr) => {
    res.json({
      success: !error,
      stdout,
      stderr,
      error: error ? error.message : null,
    });
  });
});

// Endpoint to force resynchronization of tenants and sandboxes
app.post("/debug/sync", (req, res) => {
  // Vider les tenants existants si demandé
  const { reset = false } = req.query;
  if (reset === "true") {
    console.log("Resetting tenants before sync");
    Object.keys(tenants).forEach((key) => delete tenants[key]);
  }

  // Lancer la synchronisation
  syncExistingPods();

  // Attendre un peu pour que la synchronisation se termine
  setTimeout(() => {
    res.json({
      tenants: Object.keys(tenants),
      sandboxCount: Object.values(tenants).reduce(
        (count, tenant) => count + Object.keys(tenant.sandboxes).length,
        0
      ),
    });
  }, 1000);
});

// User authentication endpoints
app.post("/auth/register", async (req, res) => {
  const { username, email, password, tenantId } = req.body;

  if (!tenantId) {
    return res.status(400).json({
      success: false,
      error: "TenantId is required for registration",
    });
  }

  try {
    // Create the user
    const user = new Parse.User();
    user.set("username", username || email);
    user.set("email", email);
    user.set("password", password);
    user.set("tenantId", tenantId);
    await user.signUp();

    // Create tenant if it doesn't exist
    if (!tenants[tenantId]) {
      // Create a new tenant with default plan
      const podName = `tenant-${tenantId}`;
      const plan = "basic";
      const resources = {
        basic: { memory: "512m", cpus: 0.5, containers: 10 },
      }[plan];

      // Check if pod already exists in Podman
      exec(`podman pod exists ${podName}`, async (existsError) => {
        if (!existsError) {
          console.log(`Pod ${podName} already exists, reusing it`);

          // Pod already exists, add it to our application
          tenants[tenantId] = {
            podName,
            plan,
            resources,
            createdAt: new Date(),
            sandboxes: {},
          };

          // Save tenant to Parse
          const tenant = new Tenant();
          tenant.set("tenantId", tenantId);
          tenant.set("podName", podName);
          tenant.set("plan", plan);
          tenant.set("resources", resources);
          tenant.set("status", "reused");
          tenant.set("user", user);
          await tenant.save();
        } else {
          // Pod doesn't exist, create it
          const podCmd = `podman pod create --name ${podName}`;
          console.log(`Executing command: ${podCmd}`);

          exec(podCmd, async (error, stdout, stderr) => {
            if (error) {
              console.error(`Error creating pod: ${error}`);
              console.error(`stderr: ${stderr}`);
              return;
            }

            console.log(`Pod created successfully: ${stdout}`);

            tenants[tenantId] = {
              podName,
              plan,
              resources,
              createdAt: new Date(),
              sandboxes: {},
            };

            // Save tenant to Parse
            const tenant = new Tenant();
            tenant.set("tenantId", tenantId);
            tenant.set("podName", podName);
            tenant.set("plan", plan);
            tenant.set("resources", resources);
            tenant.set("status", "created");
            tenant.set("user", user);
            await tenant.save();
          });
        }
      });
    } else {
      // Tenant exists, update it to link with this user
      const query = new Parse.Query(Tenant);
      query.equalTo("tenantId", tenantId);
      const tenant = await query.first();

      if (tenant) {
        tenant.set("user", user);
        await tenant.save();
      }
    }

    res.json({
      success: true,
      userId: user.id,
      username: user.get("username"),
      email: user.get("email"),
      tenantId: user.get("tenantId"),
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await Parse.User.logIn(username, password);
    const tenantId = user.get("tenantId");

    // Get tenant details if tenantId exists
    let tenantDetails = null;
    if (tenantId) {
      const query = new Parse.Query(Tenant);
      query.equalTo("tenantId", tenantId);
      const tenant = await query.first();

      if (tenant) {
        tenantDetails = {
          tenantId: tenant.get("tenantId"),
          plan: tenant.get("plan"),
          resources: tenant.get("resources"),
          status: tenant.get("status"),
        };
      }
    }

    res.json({
      success: true,
      userId: user.id,
      username: user.get("username"),
      email: user.get("email"),
      tenantId: tenantId,
      tenant: tenantDetails,
      sessionToken: user.getSessionToken(),
    });
  } catch (error) {
    res.status(401).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/auth/logout", async (req, res) => {
  try {
    await Parse.User.logOut();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Endpoint to update tenant plan
app.put("/tenants/:tenantId/plan", async (req, res) => {
  const { tenantId } = req.params;
  const { plan } = req.body;

  if (!tenants[tenantId]) {
    return res.status(404).json({ error: "Tenant not found" });
  }

  const resources = {
    basic: { memory: "512m", cpus: 0.5, containers: 10 },
    pro: { memory: "1g", cpus: 1, containers: 20 },
    business: { memory: "2g", cpus: 2, containers: 30 },
  }[plan];

  if (!resources) {
    return res.status(400).json({ error: "Invalid plan" });
  }

  // Update in-memory tenant
  tenants[tenantId].plan = plan;
  tenants[tenantId].resources = resources;

  try {
    // Update tenant in Parse
    const query = new Parse.Query(Tenant);
    query.equalTo("tenantId", tenantId);
    const tenant = await query.first();

    if (tenant) {
      tenant.set("plan", plan);
      tenant.set("resources", resources);
      await tenant.save();
    }

    res.json({
      tenantId,
      plan,
      resources,
    });
  } catch (error) {
    console.error(`Error updating tenant plan in Parse: ${error}`);
    res.status(500).json({ error: "Failed to update plan in database" });
  }
});

// Endpoint to get user's tenant
app.get("/auth/user/tenant/:userId", async (req, res) => {
  const sessionToken = req.headers.authorization?.replace("Bearer ", "");
  const { userId } = req.params;

  if (!sessionToken) {
    return res.status(401).json({
      success: false,
      error: "Authentication required",
    });
  }

  if (!userId) {
    return res.status(400).json({
      success: false,
      error: "User ID is required",
    });
  }

  try {
    const query = new Parse.Query(Parse.User);
    const user = await query.get(userId, { sessionToken });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    const tenantId = user.get("tenantId");

    if (!tenantId) {
      return res.status(404).json({
        success: false,
        error: "No tenant associated with this user",
      });
    }

    // Get tenant details
    const tenantQuery = new Parse.Query(Tenant);
    tenantQuery.equalTo("tenantId", tenantId);
    const tenant = await tenantQuery.first();

    if (!tenant) {
      return res.status(404).json({
        success: false,
        error: "Tenant not found",
      });
    }

    res.json({
      success: true,
      tenantId: tenant.get("tenantId"),
      plan: tenant.get("plan"),
      resources: tenant.get("resources"),
      status: tenant.get("status"),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Endpoint pour cloner un dépôt Git dans un sandbox
app.post("/sandboxes/:sandboxId/clone", async (req, res) => {
  const { sandboxId } = req.params;
  const { repoUrl } = req.body;

  if (!repoUrl) {
    return res.status(400).json({ error: "Repository URL is required" });
  }

  console.log(`Cloning repository ${repoUrl} into sandbox ${sandboxId}`);

  // Vérifier si le sandbox existe
  // if (!tenants[sandboxId]) {
  //   return res.status(404).json({ error: "Sandbox not found" });
  // }

  try {
    // Exécuter la commande git clone dans le conteneur
    const cloneCmd = `podman exec ${sandboxId} bash -c "mkdir -p /sandbox/repo && cd /sandbox/repo && git clone ${repoUrl} ."`;

    exec(cloneCmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error cloning repository: ${error}`);
        console.error(`stderr: ${stderr}`);
        return res.status(500).json({
          error: "Failed to clone repository",
          details: stderr,
        });
      }

      res.json({
        success: true,
        message: `Repository ${repoUrl} cloned successfully into sandbox ${sandboxId}`,
        sandboxId,
      });
    });
  } catch (e) {
    console.error(`Error in clone operation: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Endpoint pour lister les fichiers dans un sandbox
app.get("/sandboxes/:sandboxId/files", async (req, res) => {
  const { sandboxId } = req.params;
  const { path = "/sandbox" } = req.query;

  console.log(`Listing files in sandbox ${sandboxId} at path ${path}`);

  // Vérifier si le sandbox existe
  // if (!container.Names[sandboxId]) {
  //   return res.status(404).json({ error: "Sandbox not found" });
  // }

  try {
    // Exécuter la commande find pour lister les fichiers
    const findCmd = `podman exec ${sandboxId} find ${path} -type f | sort`;

    exec(findCmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error listing files: ${error}`);
        console.error(`stderr: ${stderr}`);
        return res.status(500).json({
          error: "Failed to list files",
          details: stderr,
        });
      }

      // Transformer la sortie en tableau de fichiers
      const files = stdout
        .trim()
        .split("\n")
        .filter((file) => file);

      res.json({
        success: true,
        files,
        sandboxId,
        path,
      });
    });
  } catch (e) {
    console.error(`Error in file listing operation: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Endpoint pour lire le contenu d'un fichier
app.get("/sandboxes/:sandboxId/files/content", async (req, res) => {
  const { sandboxId } = req.params;
  const { path } = req.query;

  if (!path) {
    return res.status(400).json({ error: "File path is required" });
  }

  console.log(`Reading file ${path} in sandbox ${sandboxId}`);

  // Vérifier si le sandbox existe
  // if (!tenants[sandboxId]) {
  //   return res.status(404).json({ error: "Sandbox not found" });
  // }

  try {
    // Exécuter la commande cat pour lire le contenu du fichier
    const catCmd = `podman exec ${sandboxId} cat ${path}`;

    exec(catCmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error reading file: ${error}`);
        console.error(`stderr: ${stderr}`);
        return res.status(500).json({
          error: "Failed to read file",
          details: stderr,
        });
      }

      res.json({
        success: true,
        content: stdout,
        sandboxId,
        path,
      });
    });
  } catch (e) {
    console.error(`Error in file reading operation: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Endpoint pour écrire dans un fichier
app.post("/sandboxes/:sandboxId/files/content", async (req, res) => {
  const { sandboxId } = req.params;
  const { path, content } = req.body;

  if (!path) {
    return res.status(400).json({ error: "File path is required" });
  }

  if (content === undefined) {
    return res.status(400).json({ error: "File content is required" });
  }

  console.log(`Writing to file ${path} in sandbox ${sandboxId}`);

  // Vérifier si le sandbox existe
  if (!tenants[sandboxId]) {
    return res.status(404).json({ error: "Sandbox not found" });
  }

  try {
    // Créer les répertoires parents si nécessaire
    const dirCmd = `podman exec ${sandboxId} mkdir -p $(dirname "${path}")`;

    exec(dirCmd, (dirError) => {
      if (dirError) {
        console.error(`Error creating directory: ${dirError}`);
        // Continuer même si la création du répertoire échoue (il existe peut-être déjà)
      }

      // Échapper le contenu pour éviter les problèmes avec les caractères spéciaux
      const escapedContent = content.replace(/"/g, '\\"');

      // Écrire le contenu dans le fichier
      const writeCmd = `podman exec ${sandboxId} bash -c 'cat > "${path}" << "EOF"
${content}
EOF'`;

      exec(writeCmd, (error, stdout, stderr) => {
        if (error) {
          console.error(`Error writing to file: ${error}`);
          console.error(`stderr: ${stderr}`);
          return res.status(500).json({
            error: "Failed to write to file",
            details: stderr,
          });
        }

        res.json({
          success: true,
          message: `File ${path} updated successfully`,
          sandboxId,
          path,
        });
      });
    });
  } catch (e) {
    console.error(`Error in file writing operation: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Gérer les connexions Socket.IO
io.on("connection", (socket) => {
  console.log(`[DEBUG] New client connected: ${socket.id}`);

  // Joindre une room spécifique à un sandbox
  socket.on("join-sandbox", (sandboxId) => {
    console.log(`[DEBUG] Client ${socket.id} joined sandbox ${sandboxId}`);
    socket.join(sandboxId);

    // Envoyer un message de confirmation
    socket.emit("log", {
      type: "system",
      data: `Connected to log stream for sandbox ${sandboxId}`,
    });

    // Vérifier combien de clients sont dans cette room
    const room = io.sockets.adapter.rooms.get(sandboxId);
    const numClients = room ? room.size : 0;
    console.log(
      `[DEBUG] Number of clients in room ${sandboxId}: ${numClients}`
    );
  });

  // Quitter une room
  socket.on("leave-sandbox", (sandboxId) => {
    socket.leave(sandboxId);
    console.log(`[DEBUG] Client ${socket.id} left sandbox ${sandboxId}`);
  });

  // Gérer la déconnexion
  socket.on("disconnect", () => {
    console.log(`[DEBUG] Client disconnected: ${socket.id}`);
  });
});

// Améliorer la fonction broadcastLogs pour plus de détails
function broadcastLogs(sandboxId, logType, data) {
  try {
    // Convertir les données en chaîne si ce n'est pas déjà le cas
    const logData = typeof data === "string" ? data : data.toString();

    // Découper les logs en lignes pour éviter les messages trop longs
    const lines = logData.split("\n");

    console.log(
      `[DEBUG] Broadcasting ${lines.length} log lines for sandbox ${sandboxId}`
    );

    // Envoyer chaque ligne séparément
    lines.forEach((line) => {
      if (line.trim()) {
        // Ignorer les lignes vides
        console.log(
          `[DEBUG] Broadcasting to ${sandboxId}: ${logType} - ${line.substring(
            0,
            50
          )}${line.length > 50 ? "..." : ""}`
        );
        io.to(sandboxId).emit("log", {
          type: logType,
          data: line,
        });
      }
    });
  } catch (error) {
    console.error(`[ERROR] Error in broadcastLogs: ${error.message}`);
  }
}

// Modifier l'endpoint pour démarrer l'application afin de capturer et diffuser les logs
app.post("/tenants/:tenantName/sandboxes/:sandboxId/start", (req, res) => {
  const { tenantName, sandboxId } = req.params;
  const containerId = `tenant-${tenantName}-${sandboxId}-${Date.now()}`;
  const { command = "npm run dev" } = req.body;

  // Vérifier si le conteneur existe
  exec(
    `podman ps -a --filter name=${containerId} --format "{{.Names}}"`,
    (error, stdout, stderr) => {
      if (error) {
        console.error(`Error checking container: ${error.message}`);
        return res.status(500).json({ error: "Failed to check container" });
      }

      if (!stdout.trim()) {
        return res.status(404).json({
          error: "Container not found. Please clone a repository first.",
        });
      }

      // Arrêter le processus existant si nécessaire
      if (sandboxProcesses.has(sandboxId)) {
        try {
          sandboxProcesses.get(sandboxId).kill();
          console.log(`Stopped existing process for sandbox ${sandboxId}`);
        } catch (err) {
          console.error(`Error stopping process: ${err.message}`);
        }
      }

      // Utiliser spawn au lieu de exec pour capturer les flux stdout et stderr en continu
      const process = spawn("podman", [
        "exec",
        containerId,
        "bash",
        "-c",
        `cd /sandbox/repo && ${command}`,
      ]);

      // Stocker le processus pour pouvoir l'arrêter plus tard
      sandboxProcesses.set(sandboxId, process);

      // Capturer et diffuser stdout
      process.stdout.on("data", (data) => {
        console.log(`[${sandboxId}] stdout: ${data}`);
        broadcastLogs(sandboxId, "stdout", data);
      });

      // Capturer et diffuser stderr
      process.stderr.on("data", (data) => {
        console.error(`[${sandboxId}] stderr: ${data}`);
        broadcastLogs(sandboxId, "stderr", data);
      });

      // Gérer la fin du processus
      process.on("close", (code) => {
        console.log(`[${sandboxId}] Process exited with code ${code}`);
        broadcastLogs(sandboxId, "system", `Process exited with code ${code}`);
        sandboxProcesses.delete(sandboxId);
      });

      // Trouver le port mappé
      exec(`podman port ${containerId}`, (error, stdout, stderr) => {
        if (error) {
          console.error(`Error getting port mapping: ${error.message}`);
          return res.status(500).json({
            success: true,
            message: "Application started, but couldn't determine port mapping",
            containerId,
          });
        }

        console.log(`Application started for sandbox ${sandboxId}`);
        res.json({
          success: true,
          message: "Application started successfully",
          portMapping: stdout,
          containerId,
        });
      });
    }
  );
});

// Endpoint pour arrêter l'application
app.post("/tenants/:tenantName/sandboxes/:sandboxId/stop", (req, res) => {
  const { sandboxId } = req.params;

  if (sandboxProcesses.has(sandboxId)) {
    try {
      sandboxProcesses.get(sandboxId).kill();
      sandboxProcesses.delete(sandboxId);
      broadcastLogs(sandboxId, "system", "Application stopped");
      res.json({ success: true, message: "Application stopped successfully" });
    } catch (error) {
      console.error(`Error stopping process: ${error.message}`);
      res.status(500).json({ error: "Failed to stop application" });
    }
  } else {
    res
      .status(404)
      .json({ error: "No running application found for this sandbox" });
  }
});

// Endpoint pour installer les dépendances npm et lancer l'application
app.post("/sandboxes/:sandboxId/install-and-start", async (req, res) => {
  const { sandboxId } = req.params;
  const { command = "npm run dev", cwd = "/sandbox/repo" } = req.body;

  console.log(`[DEBUG] Starting install-and-start for sandbox ${sandboxId}`);
  console.log(`[DEBUG] Command: ${command}, Working directory: ${cwd}`);

  try {
    // Vérifier si le sandbox existe
    console.log(`[DEBUG] Checking if sandbox ${sandboxId} exists...`);
    exec(
      `podman ps -a --filter name=${sandboxId} --format "{{.Names}}"`,
      (error, stdout, stderr) => {
        if (error) {
          console.error(`[ERROR] Error checking container: ${error.message}`);
          console.error(`[ERROR] stderr: ${stderr}`);
          return res.status(500).json({ error: "Failed to check container" });
        }

        if (!stdout.trim()) {
          console.error(`[ERROR] Container ${sandboxId} not found`);
          return res.status(404).json({
            error: "Container not found. Please clone a repository first.",
          });
        }

        console.log(`[DEBUG] Container ${sandboxId} found: ${stdout.trim()}`);

        // Arrêter le processus existant si nécessaire
        if (sandboxProcesses.has(sandboxId)) {
          try {
            console.log(
              `[DEBUG] Stopping existing process for sandbox ${sandboxId}`
            );
            sandboxProcesses.get(sandboxId).kill();
            console.log(
              `[DEBUG] Stopped existing process for sandbox ${sandboxId}`
            );
          } catch (err) {
            console.error(`[ERROR] Error stopping process: ${err.message}`);
          }
        }

        // Vérifier l'état du conteneur avant d'exécuter la commande
        console.log(`[DEBUG] Checking container state for ${sandboxId}...`);
        exec(
          `podman inspect --format "{{.State.Status}}" ${sandboxId}`,
          (inspectError, inspectStdout) => {
            if (inspectError) {
              console.error(
                `[ERROR] Error inspecting container: ${inspectError.message}`
              );
              return res
                .status(500)
                .json({ error: "Failed to inspect container" });
            }

            const containerStatus = inspectStdout.trim();
            console.log(
              `[DEBUG] Container ${sandboxId} status: ${containerStatus}`
            );

            // Si le conteneur n'est pas en cours d'exécution, le démarrer
            if (containerStatus !== "running") {
              console.log(`[DEBUG] Starting container ${sandboxId}...`);
              exec(`podman start ${sandboxId}`, (startError) => {
                if (startError) {
                  console.error(
                    `[ERROR] Error starting container: ${startError.message}`
                  );
                  return res
                    .status(500)
                    .json({ error: "Failed to start container" });
                }
                console.log(
                  `[DEBUG] Container ${sandboxId} started successfully`
                );
                executeCommand();
              });
            } else {
              console.log(`[DEBUG] Container ${sandboxId} is already running`);
              executeCommand();
            }
          }
        );

        function executeCommand() {
          console.log(
            `[DEBUG] Executing command in container ${sandboxId}: cd ${cwd} && npm install --legacy-peer-deps && ${command}`
          );

          // Vérifier d'abord si le répertoire existe
          exec(
            `podman exec ${sandboxId} bash -c "[ -d ${cwd} ] && echo 'Directory exists' || echo 'Directory does not exist'"`,
            (dirCheckError, dirCheckStdout) => {
              if (dirCheckError) {
                console.error(
                  `[ERROR] Error checking directory: ${dirCheckError.message}`
                );
              }

              console.log(
                `[DEBUG] Directory check result: ${dirCheckStdout.trim()}`
              );

              if (dirCheckStdout.includes("does not exist")) {
                console.log(`[DEBUG] Creating directory ${cwd}`);
                exec(
                  `podman exec ${sandboxId} bash -c "mkdir -p ${cwd}"`,
                  (mkdirError) => {
                    if (mkdirError) {
                      console.error(
                        `[ERROR] Error creating directory: ${mkdirError.message}`
                      );
                    }
                    startProcess();
                  }
                );
              } else {
                startProcess();
              }
            }
          );

          function startProcess() {
            // Créer un ID unique pour ce processus
            const processId = `${sandboxId}-${Date.now()}`;
            const logFile = path.join(logsDir, `${processId}.log`);

            console.log(
              `[DEBUG] Starting process ${processId} with logs at ${logFile}`
            );

            // Créer un flux pour les logs
            const logStream = fs.createWriteStream(logFile, { flags: "a" });

            // Utiliser spawn au lieu de exec pour capturer les flux stdout et stderr en continu
            console.log(`[DEBUG] Spawning process for sandbox ${sandboxId}`);
            const process = spawn("bash", [
              "-c",
              `podman exec ${sandboxId} bash -c "cd ${cwd} && npm install --legacy-peer-deps && ${command}"`,
            ]);

            // Stocker le processus et ses informations
            sandboxProcesses.set(sandboxId, process);
            runningProcesses.set(processId, {
              sandboxId,
              process,
              logFile,
              startTime: new Date(),
              status: "running",
            });

            // Envoyer une réponse immédiate avec l'ID du processus
            res.json({
              success: true,
              message: "Installation and startup process initiated",
              sandboxId,
              processId,
            });

            console.log(`[DEBUG] Process spawned for sandbox ${sandboxId}`);

            // Capturer et enregistrer stdout
            process.stdout.on("data", (data) => {
              const dataStr = data.toString();
              logStream.write(dataStr);
              console.log(`[${processId}] stdout: ${dataStr.trim()}`);
              broadcastLogs(sandboxId, "stdout", dataStr);
            });

            // Capturer et enregistrer stderr
            process.stderr.on("data", (data) => {
              const dataStr = data.toString();
              logStream.write(dataStr);
              console.error(`[${processId}] stderr: ${dataStr.trim()}`);
              broadcastLogs(sandboxId, "stderr", dataStr);
            });

            // Gérer la fin du processus
            process.on("close", (code) => {
              console.log(
                `[DEBUG] Process ${processId} exited with code ${code}`
              );
              logStream.end(`\n[Process exited with code ${code}]\n`);
              logStream.close();

              // Mettre à jour le statut du processus
              if (runningProcesses.has(processId)) {
                const processInfo = runningProcesses.get(processId);
                processInfo.status = "completed";
                processInfo.endTime = new Date();
                processInfo.exitCode = code;
                runningProcesses.set(processId, processInfo);
              }

              broadcastLogs(
                sandboxId,
                "system",
                `Process exited with code ${code}`
              );
              sandboxProcesses.delete(sandboxId);
            });

            // Gérer les erreurs du processus
            process.on("error", (err) => {
              console.error(
                `[ERROR] Process error for ${processId}: ${err.message}`
              );
              logStream.write(`\n[ERROR] ${err.message}\n`);

              if (runningProcesses.has(processId)) {
                const processInfo = runningProcesses.get(processId);
                processInfo.status = "error";
                processInfo.error = err.message;
                runningProcesses.set(processId, processInfo);
              }

              broadcastLogs(
                sandboxId,
                "system",
                `Process error: ${err.message}`
              );
            });
          }
        }
      }
    );
  } catch (e) {
    console.error(`[ERROR] Error in install and start operation: ${e.message}`);
    console.error(e.stack);
    res.status(500).json({ error: e.message });
  }
});

// Endpoint pour récupérer les logs d'un processus
app.get("/processes/:processId/logs", (req, res) => {
  const { processId } = req.params;
  const { offset = 0 } = req.query;

  console.log(
    `[DEBUG] Fetching logs for process ${processId} with offset ${offset}`
  );

  const processInfo = runningProcesses.get(processId);

  if (!processInfo) {
    console.error(`[ERROR] Process ${processId} not found`);
    return res.status(404).json({ error: "Process not found" });
  }

  try {
    // Lire les statistiques du fichier de logs pour obtenir sa taille
    const stats = fs.statSync(processInfo.logFile);
    const fileSize = stats.size;

    // Calculer combien de données lire
    const offsetValue = parseInt(offset, 10) || 0;
    const length = fileSize - offsetValue;

    if (length <= 0) {
      // Pas de nouvelles données
      console.log(`[DEBUG] No new logs for process ${processId}`);
      return res.json({
        logs: "",
        nextOffset: fileSize,
        status: processInfo.status,
      });
    }

    // Lire depuis le fichier
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(processInfo.logFile, "r");
    fs.readSync(fd, buffer, 0, length, offsetValue);
    fs.closeSync(fd);

    const logs = buffer.toString("utf8");
    console.log(
      `[DEBUG] Returning ${logs.length} bytes of logs for process ${processId}`
    );

    return res.json({
      logs,
      nextOffset: fileSize,
      status: processInfo.status,
    });
  } catch (error) {
    console.error(
      `[ERROR] Error reading logs for process ${processId}: ${error}`
    );
    return res.status(500).json({ error: "Unable to read logs" });
  }
});

// Endpoint pour lister les processus en cours
app.get("/processes", (req, res) => {
  const processes = Array.from(runningProcesses.entries()).map(
    ([id, info]) => ({
      processId: id,
      sandboxId: info.sandboxId,
      status: info.status,
      startTime: info.startTime,
      endTime: info.endTime,
      exitCode: info.exitCode,
    })
  );

  res.json({ processes });
});

// Endpoint pour redémarrer un conteneur
app.post("/sandboxes/:sandboxId/restart", async (req, res) => {
  const { sandboxId } = req.params;

  console.log(`[DEBUG] Restarting container ${sandboxId}`);

  try {
    // Vérifier si le conteneur existe
    exec(
      `podman ps -a --filter name=${sandboxId} --format "{{.Names}}"`,
      (error, stdout, stderr) => {
        if (error) {
          console.error(`[ERROR] Error checking container: ${error.message}`);
          console.error(`[ERROR] stderr: ${stderr}`);
          return res.status(500).json({
            success: false,
            error: "Failed to check container",
          });
        }

        if (!stdout.trim()) {
          console.error(`[ERROR] Container ${sandboxId} not found`);
          return res.status(404).json({
            success: false,
            error: "Container not found",
          });
        }

        // Arrêter le processus existant si nécessaire
        if (sandboxProcesses.has(sandboxId)) {
          try {
            console.log(
              `[DEBUG] Stopping existing process for sandbox ${sandboxId}`
            );
            sandboxProcesses.get(sandboxId).kill();
            console.log(
              `[DEBUG] Stopped existing process for sandbox ${sandboxId}`
            );
          } catch (err) {
            console.error(`[ERROR] Error stopping process: ${err.message}`);
          }
        }

        // Redémarrer le conteneur
        console.log(`[DEBUG] Restarting container ${sandboxId}...`);
        exec(
          `podman restart ${sandboxId}`,
          (restartError, restartStdout, restartStderr) => {
            if (restartError) {
              console.error(
                `[ERROR] Error restarting container: ${restartError.message}`
              );
              console.error(`[ERROR] stderr: ${restartStderr}`);
              return res.status(500).json({
                success: false,
                error: "Failed to restart container",
              });
            }

            console.log(
              `[DEBUG] Container ${sandboxId} restarted successfully`
            );

            // Créer un ID unique pour ce processus de redémarrage
            const processId = `${sandboxId}-restart-${Date.now()}`;
            const logFile = path.join(logsDir, `${processId}.log`);

            console.log(`[DEBUG] Creating log file for restart: ${logFile}`);

            // Créer un flux pour les logs
            const logStream = fs.createWriteStream(logFile, { flags: "a" });

            // Enregistrer les informations du processus
            const processInfo = {
              sandboxId,
              processId,
              logFile,
              status: "running",
              startTime: new Date(),
              command: "restart",
            };

            runningProcesses.set(processId, processInfo);

            // Écrire un message de redémarrage dans le fichier de logs
            logStream.write(
              `[${new Date().toISOString()}] Container ${sandboxId} restarted\n`
            );

            // Diffuser les logs du conteneur après le redémarrage
            const logsCmd = spawn("bash", [
              "-c",
              `podman logs -f ${sandboxId}`,
            ]);

            // Capturer et enregistrer stdout
            logsCmd.stdout.on("data", (data) => {
              const dataStr = data.toString();
              logStream.write(dataStr);
              console.log(`[${processId}] stdout: ${dataStr.trim()}`);
              broadcastLogs(sandboxId, "stdout", dataStr);
            });

            // Capturer et enregistrer stderr
            logsCmd.stderr.on("data", (data) => {
              const dataStr = data.toString();
              logStream.write(dataStr);
              console.error(`[${processId}] stderr: ${dataStr.trim()}`);
              broadcastLogs(sandboxId, "stderr", dataStr);
            });

            // Gérer la fin du processus de logs
            logsCmd.on("close", (code) => {
              console.log(
                `[DEBUG] Logs process for ${processId} exited with code ${code}`
              );
              logStream.end(`\n[Logs process exited with code ${code}]\n`);
              logStream.close();

              // Mettre à jour le statut du processus
              if (runningProcesses.has(processId)) {
                const info = runningProcesses.get(processId);
                info.status = "completed";
                info.endTime = new Date();
                info.exitCode = code;
                runningProcesses.set(processId, info);
              }
            });

            // Stocker le processus de logs
            sandboxProcesses.set(sandboxId, logsCmd);

            return res.json({
              success: true,
              message: "Container restarted successfully",
              processId,
            });
          }
        );
      }
    );
  } catch (e) {
    console.error(`[ERROR] Error in restart operation: ${e.message}`);
    console.error(e.stack);
    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

// Endpoint pour créer une instance de prévisualisation
app.post("/sandboxes/:sandboxId/preview", async (req, res) => {
  const { sandboxId } = req.params;
  const { port = 3000 } = req.body;

  // Vérifier si le port demandé est l'un des ports standard
  if (![3000, 8080, 5000].includes(port)) {
    return res.status(400).json({
      error: `Port ${port} not available. Available ports: 3000, 8080, 5000`,
    });
  }

  const instanceId = `preview-${sandboxId}-${Date.now()}`;
  const accessUrl = `http://localhost:${port}`;

  console.log(`[DEBUG] Preview URL: ${accessUrl}`);

  res.json({
    instanceId,
    status: "created",
    port: port,
    accessUrl,
  });
});

// Endpoint pour arrêter une prévisualisation
app.delete("/sandboxes/:sandboxId/preview/:instanceId", async (req, res) => {
  // Comme nous utilisons simplement les ports déjà exposés,
  // il n'y a rien à nettoyer lors de la fermeture de la prévisualisation
  res.json({
    success: true,
    message: "Preview closed successfully",
  });
});

// Endpoint pour lister les prévisualisations actives
app.get("/sandboxes/:sandboxId/previews", async (req, res) => {
  const { sandboxId } = req.params;

  console.log(`[DEBUG] Listing previews for sandbox ${sandboxId}`);

  try {
    exec(
      `podman ps --filter name=preview-${sandboxId} --format json`,
      (error, stdout, stderr) => {
        if (error) {
          console.error(`[ERROR] Error listing previews: ${error.message}`);
          console.error(`[ERROR] stderr: ${stderr}`);
          return res.status(500).json({
            error: "Failed to list previews",
            details: stderr,
          });
        }

        try {
          const containers = stdout.trim() ? JSON.parse(stdout) : [];
          const previews = containers.map((container) => {
            const ports = container.Ports || [];
            const portMapping = ports
              .map((p) => `${p.hostPort}:${p.containerPort}`)
              .join(", ");

            return {
              instanceId: container.Names[0],
              status: container.State,
              created: container.Created,
              ports: portMapping,
              accessUrl:
                ports.length > 0
                  ? `http://localhost:${ports[0].hostPort}`
                  : null,
            };
          });

          res.json({
            sandboxId,
            previews,
          });
        } catch (parseError) {
          console.error(
            `[ERROR] Error parsing container list: ${parseError.message}`
          );
          res.status(500).json({
            error: "Failed to parse preview list",
            details: parseError.message,
          });
        }
      }
    );
  } catch (e) {
    console.error(`[ERROR] Error listing previews: ${e.message}`);
    console.error(e.stack);
    res.status(500).json({ error: e.message });
  }
});

// Utiliser server.listen au lieu de app.listen
server.listen(port, () => {
  console.log(`Sandbox manager running on port ${port}`);
});
