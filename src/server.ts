import { join } from "node:path";
import { createDisproHttpServer } from "./api/httpServer.js";
import { sampleNodes } from "./sample/sampleNodes.js";
import { createMailerFromEnv } from "./services/authService.js";
import { FileDisproStore } from "./storage/fileDisproStore.js";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const dataPath = process.env.DISPRO_DATA_PATH ?? join(process.cwd(), ".dispro", "state.json");
const staticDirectory = join(process.cwd(), "public");
const store = await FileDisproStore.open(dataPath, sampleNodes);
const authOptions = {
  mailer: createMailerFromEnv(),
  exposeDevSignInLinks: process.env.DISPRO_EXPOSE_DEV_SIGNIN_LINKS !== "false"
};

if (process.env.DISPRO_AUTH_BASE_URL !== undefined) {
  Object.assign(authOptions, { baseUrl: process.env.DISPRO_AUTH_BASE_URL });
}

const server = createDisproHttpServer({
  store,
  staticDirectory,
  auth: authOptions
});

server.listen(port, () => {
  console.log(`Dispro API listening on http://localhost:${port}`);
  console.log(`State file: ${dataPath}`);
});
