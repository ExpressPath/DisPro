import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const source = join(root, "android", "process-app");
const output = join(root, "dist", "android-process");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });

const gradlePath = join(output, "app", "build.gradle.kts");
const versionCode = packageJson.version
  .split(".")
  .map((part) => Number.parseInt(part, 10))
  .reduce((code, part) => code * 100 + (Number.isFinite(part) ? part : 0), 0);
const gradle = await readFile(gradlePath, "utf8");
await writeFile(
  gradlePath,
  gradle
    .replace(/versionCode = \d+/, `versionCode = ${versionCode}`)
    .replace(/versionName = "[^"]+"/, `versionName = "${packageJson.version}"`),
  "utf8"
);

console.log(`Android Process app source written to ${output}`);
