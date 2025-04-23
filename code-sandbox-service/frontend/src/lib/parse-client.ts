import Parse from "parse";

// Initialiser Parse
Parse.initialize(
  process.env.NEXT_PUBLIC_PARSE_APP_ID || "myAppId",
  process.env.NEXT_PUBLIC_PARSE_JS_KEY || "masterKey"
);
Parse.serverURL =
  process.env.NEXT_PUBLIC_PARSE_SERVER_URL || "http://localhost:1337/parse";

// Types
export interface TenantAttributes {
  name: string;
  plan: string;
  podName: string;
  resources: {
    memory: string;
    cpus: number;
    containers: number;
  };
  owner: Parse.User;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface SandboxAttributes {
  sandboxId: string;
  containerId: string;
  status: string;
  tenant: Parse.Object;
  createdBy: Parse.User;
  createdAt?: Date;
  updatedAt?: Date;
}

// Modèles Parse
export class Tenant extends Parse.Object<TenantAttributes> {
  constructor(attributes?: TenantAttributes) {
    super("Tenant", attributes);
  }

  get name(): string {
    return this.get("name");
  }
  set name(value: string) {
    this.set("name", value);
  }

  get plan(): string {
    return this.get("plan");
  }
  set plan(value: string) {
    this.set("plan", value);
  }

  get podName(): string {
    return this.get("podName");
  }
  set podName(value: string) {
    this.set("podName", value);
  }

  get resources(): TenantAttributes["resources"] {
    return this.get("resources");
  }
  set resources(value: TenantAttributes["resources"]) {
    this.set("resources", value);
  }

  get owner(): Parse.User {
    return this.get("owner");
  }
  set owner(value: Parse.User) {
    this.set("owner", value);
  }
}

export class Sandbox extends Parse.Object<SandboxAttributes> {
  constructor(attributes?: SandboxAttributes) {
    super("Sandbox", attributes);
  }

  get sandboxId(): string {
    return this.get("sandboxId");
  }
  set sandboxId(value: string) {
    this.set("sandboxId", value);
  }

  get containerId(): string {
    return this.get("containerId");
  }
  set containerId(value: string) {
    this.set("containerId", value);
  }

  get status(): string {
    return this.get("status");
  }
  set status(value: string) {
    this.set("status", value);
  }

  get tenant(): Parse.Object {
    return this.get("tenant");
  }
  set tenant(value: Parse.Object) {
    this.set("tenant", value);
  }

  get createdBy(): Parse.User {
    return this.get("createdBy");
  }
  set createdBy(value: Parse.User) {
    this.set("createdBy", value);
  }
}

// Enregistrer les classes
Parse.Object.registerSubclass("Tenant", Tenant);
Parse.Object.registerSubclass("Sandbox", Sandbox);

// API Functions
export const parseAPI = {
  // Auth
  async register(username: string, email: string, password: string) {
    const user = new Parse.User();
    user.set("username", username);
    user.set("email", email);
    user.set("password", password);

    await user.signUp();
    return user;
  },

  async login(username: string, password: string) {
    return await Parse.User.logIn(username, password);
  },

  async logout() {
    return await Parse.User.logOut();
  },

  async getCurrentUser() {
    return Parse.User.current();
  },

  // Tenants
  async createTenant(name: string, plan: string = "basic") {
    const currentUser = Parse.User.current();
    if (!currentUser) throw new Error("User not authenticated");

    // Appeler l'API pour créer le pod
    const response = await fetch("http://localhost:3001/create-pod", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tenantId: name, plan }),
    });

    const data = await response.json();

    // Créer l'objet Tenant dans Parse
    const tenant = new Tenant();
    tenant.name = name;
    tenant.plan = plan;
    tenant.podName = data.podName;
    tenant.resources = data.resources;
    tenant.owner = currentUser;

    await tenant.save();
    return tenant;
  },

  async getTenants() {
    const currentUser = Parse.User.current();
    if (!currentUser) throw new Error("User not authenticated");

    const query = new Parse.Query(Tenant);
    query.equalTo("owner", currentUser);
    return await query.find();
  },

  async getTenant(id: string) {
    const query = new Parse.Query(Tenant);
    return await query.get(id);
  },

  // Sandboxes
  async createSandbox(tenantId: string, userId: string) {
    const currentUser = Parse.User.current();
    if (!currentUser) throw new Error("User not authenticated");

    debugger;

    // Récupérer le tenant
    const tenantQuery = new Parse.Query(Tenant);
    const tenant = await tenantQuery.get(tenantId);

    // Appeler l'API pour créer le sandbox
    const response = await fetch(
      `http://localhost:3001/tenants/${tenant.name}/sandboxes`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ userId }),
      }
    );

    const data = await response.json();

    // Créer l'objet Sandbox dans Parse
    const sandbox = new Sandbox();
    sandbox.sandboxId = data.sandboxId;
    sandbox.containerId = data.containerId;
    sandbox.status = data.status;
    sandbox.tenant = tenant;
    sandbox.createdBy = currentUser;

    await sandbox.save();
    return sandbox;
  },

  async getSandboxes(tenantId: string) {
    // Créer une requête pour récupérer les sandboxes associés à ce tenant
    const tenantQuery = new Parse.Query(Tenant);
    const tenant = await tenantQuery.equalTo("tenantId", tenantId);

    const query = new Parse.Query(Sandbox);
    query.equalTo("tenantId", tenantId);

    try {
      const results = await query.find();
      return results.map((sandbox) => ({
        id: sandbox.id,
        sandboxId: sandbox.get("sandboxId"),
        containerId: sandbox.get("containerId"),
        status: sandbox.get("status"),
        createdAt: sandbox.get("createdAt"),
        userId: sandbox.get("userId"),
      }));
    } catch (error) {
      console.error("Error fetching sandboxes:", error);
      throw error;
    }
  },

  async executeCode(sandboxId: string, code: string) {
    // Trouver le sandbox
    const query = new Parse.Query(Sandbox);
    query.equalTo("sandboxId", sandboxId);
    const sandbox = await query.first();

    if (!sandbox) throw new Error("Sandbox not found");

    // Récupérer le tenant
    const tenant = await sandbox.tenant.fetch();

    // Appeler l'API pour exécuter le code
    const response = await fetch(
      `http://localhost:3001/tenants/${tenant.get(
        "name"
      )}/sandboxes/${sandboxId}/execute`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code }),
      }
    );

    return await response.json();
  },

  async deleteSandbox(sandboxId: string) {
    // Trouver le sandbox
    const query = new Parse.Query(Sandbox);
    query.equalTo("sandboxId", sandboxId);
    const sandbox = await query.first();

    if (!sandbox) throw new Error("Sandbox not found");

    // Récupérer le tenant
    const tenant = await sandbox.tenant.fetch();

    // Appeler l'API pour supprimer le sandbox
    await fetch(
      `http://localhost:3001/tenants/${tenant.get(
        "name"
      )}/sandboxes/${sandboxId}`,
      {
        method: "DELETE",
      }
    );

    // Supprimer l'objet Sandbox dans Parse
    await sandbox.destroy();
  },
};

export default Parse;

// User-related functions
export const registerUser = async (
  username: string,
  email: string,
  password: string,
  tenantId: string
) => {
  try {
    const response = await fetch("http://localhost:3001/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, email, password, tenantId }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Registration failed");
    }

    return await response.json();
  } catch (error) {
    console.error("Registration error:", error);
    throw error;
  }
};

export const loginUser = async (username: string, password: string) => {
  try {
    const response = await fetch("http://localhost:3001/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Login failed");
    }

    const data = await response.json();

    // Store session token in localStorage
    if (data.sessionToken) {
      localStorage.setItem("sessionToken", data.sessionToken);
    }

    return data;
  } catch (error) {
    console.error("Login error:", error);
    throw error;
  }
};

export const logoutUser = async () => {
  try {
    const response = await fetch("http://localhost:3001/auth/logout", {
      method: "POST",
    });

    // Clear session token from localStorage
    localStorage.removeItem("sessionToken");

    return await response.json();
  } catch (error) {
    console.error("Logout error:", error);
    throw error;
  }
};

export const getCurrentUserTenant = async (
  userId: string,
  sessionToken: string
) => {
  try {
    if (!sessionToken) {
      throw new Error("No session token found");
    }

    const response = await fetch(
      `http://localhost:3001/auth/user/tenant/${userId}`,
      {
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Failed to get tenant");
    }

    return await response.json();
  } catch (error) {
    console.error("Get tenant error:", error);
    throw error;
  }
};
