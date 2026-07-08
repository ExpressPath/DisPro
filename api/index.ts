import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDisproHttpRequestHandler } from "../src/api/httpServer.js";
import { sampleNodes } from "../src/sample/sampleNodes.js";
import { createMailerFromEnv } from "../src/services/authService.js";
import { FileDisproStore } from "../src/storage/fileDisproStore.js";

const dataPath = process.env.DISPRO_DATA_PATH ?? join(tmpdir(), "dispro-vercel-state.json");
const storePromise = FileDisproStore.open(dataPath, sampleNodes);

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const store = await storePromise;
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

function shouldExposeDevSignInCodes(): boolean {
  if (process.env.DISPRO_EXPOSE_DEV_SIGNIN_LINKS !== undefined) {
    return process.env.DISPRO_EXPOSE_DEV_SIGNIN_LINKS === "true";
  }
  return process.env.NODE_ENV !== "production" && process.env.VERCEL !== "1";
}
