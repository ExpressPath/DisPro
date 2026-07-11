import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const source = join(root, "chrome", "process-extension");
const output = join(root, "dist", "chrome-process");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });

const manifestPath = join(output, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.version = packageJson.version;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Chrome Process extension written to ${output}`);
