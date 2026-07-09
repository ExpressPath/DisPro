import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDisproHttpRequestHandler } from "../src/api/httpServer.js";
import { sampleNodes } from "../src/sample/sampleNodes.js";
import { createMailerFromEnv } from "../src/services/authService.js";
import { FileDisproStore } from "../src/storage/fileDisproStore.js";
import { NeonDisproStore } from "../src/storage/neonDisproStore.js";

const dataPath = process.env.DISPRO_DATA_PATH ?? join(tmpdir(), "dispro-vercel-state.json");
let storePromise: ReturnType<typeof openStore> | undefined;

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const store = await getStore();
  const authOptions = {
    mailer: createMailerFromEnv(),
    exposeDevSignInLinks: shouldExposeDevSignInCodes()
  };

  if (process.env.DISPRO_AUTH_BASE_URL !== undefined) {
    Object.assign(authOptions, { baseUrl: process.env.DISPRO_AUTH_BASE_URL });
  }

  return new Promise((resolve, reject) => {
    response.on("finish", resolve);
    response.on("error", reject);
    createDisproHttpRequestHandler({
      store,
      auth: authOptions
    })(request, response);
  });
}

async function getStore() {
  storePromise ??= openStore();
  try {
    return await storePromise;
  } catch (error) {
    storePromise = undefined;
    throw error;
  }
}

async function openStore() {
  return process.env.DATABASE_URL === undefined
    ? FileDisproStore.open(dataPath, sampleNodes)
    : NeonDisproStore.open(process.env.DATABASE_URL, sampleNodes);
}

function shouldExposeDevSignInCodes(): boolean {
  if (process.env.DISPRO_EXPOSE_DEV_SIGNIN_LINKS !== undefined) {
    return process.env.DISPRO_EXPOSE_DEV_SIGNIN_LINKS === "true";
  }
  return process.env.NODE_ENV !== "production" && process.env.VERCEL !== "1";
}
