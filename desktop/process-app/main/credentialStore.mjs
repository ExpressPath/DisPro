const API_BASE_URL_KEY = "apiBaseUrl";
const SESSION_TOKEN_KEY = "sessionToken";
const PROCESS_API_KEY_KEY = "processApiKey";

export function createCredentialStore(serviceName) {
  return {
    async saveAuth(auth) {
      const keytar = await loadKeytar();
      await keytar.setPassword(serviceName, API_BASE_URL_KEY, auth.apiBaseUrl);
      await keytar.setPassword(serviceName, SESSION_TOKEN_KEY, auth.sessionToken);
      await keytar.setPassword(serviceName, PROCESS_API_KEY_KEY, auth.processApiKey);
    },

    async loadAuth() {
      const keytar = await loadKeytar();
      const [apiBaseUrl, sessionToken, processApiKey] = await Promise.all([
        keytar.getPassword(serviceName, API_BASE_URL_KEY),
        keytar.getPassword(serviceName, SESSION_TOKEN_KEY),
        keytar.getPassword(serviceName, PROCESS_API_KEY_KEY)
      ]);

      if (!apiBaseUrl || !sessionToken || !processApiKey) {
        return undefined;
      }

      return {
        apiBaseUrl,
        sessionToken,
        processApiKey
      };
    },

    async clearAuth() {
      const keytar = await loadKeytar();
      await Promise.all([
        keytar.deletePassword(serviceName, API_BASE_URL_KEY),
        keytar.deletePassword(serviceName, SESSION_TOKEN_KEY),
        keytar.deletePassword(serviceName, PROCESS_API_KEY_KEY)
      ]);
    }
  };
}

async function loadKeytar() {
  try {
    const moduleName = "keytar";
    return await import(moduleName);
  } catch (error) {
    if (process.env.DISPRO_ALLOW_INSECURE_CREDENTIAL_FALLBACK === "true") {
      return memoryCredentialStore;
    }

    throw new Error(
      "Windows Credential Manager dependency is unavailable. Install optional dependency keytar or set DISPRO_ALLOW_INSECURE_CREDENTIAL_FALLBACK=true for temporary local development."
    );
  }
}

const memory = new Map();
const memoryCredentialStore = {
  async setPassword(service, account, password) {
    memory.set(`${service}:${account}`, password);
  },
  async getPassword(service, account) {
    return memory.get(`${service}:${account}`) ?? null;
  },
  async deletePassword(service, account) {
    memory.delete(`${service}:${account}`);
    return true;
  }
};
