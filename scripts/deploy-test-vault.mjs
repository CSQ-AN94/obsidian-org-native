import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultVault = path.join(root, "test-vault");
const vault = process.env.ORG_TEST_VAULT ? path.resolve(process.env.ORG_TEST_VAULT) : defaultVault;

const obsidianDir = path.join(vault, ".obsidian");
if (vault !== defaultVault && !fs.existsSync(obsidianDir)) {
  console.error(`Refusing to deploy to uninitialized external vault without .obsidian/: ${vault}`);
  process.exit(1);
}

const pluginDir = path.join(obsidianDir, "plugins", "org-native");
fs.mkdirSync(pluginDir, { recursive: true });

for (const file of ["main.js", "manifest.json", "styles.css"]) {
  const src = path.join(root, file);
  if (!fs.existsSync(src)) {
    console.error(`Missing build artifact: ${src}. Run "npm run build" first.`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(pluginDir, file));
}

const communityPluginsPath = path.join(obsidianDir, "community-plugins.json");
fs.writeFileSync(communityPluginsPath, JSON.stringify(["org-native"], null, 2) + "\n");

const appConfigPath = path.join(obsidianDir, "app.json");
let appConfig = {};
if (fs.existsSync(appConfigPath)) {
  try {
    appConfig = JSON.parse(fs.readFileSync(appConfigPath, "utf8"));
  } catch {
    appConfig = {};
  }
}
appConfig.showUnsupportedFiles = true;
fs.writeFileSync(appConfigPath, JSON.stringify(appConfig, null, 2) + "\n");

console.log(`Deployed org-native plugin to ${pluginDir}`);
console.log(`Configured community-plugins.json (["org-native"]) and app.json (showUnsupportedFiles: true)`);
