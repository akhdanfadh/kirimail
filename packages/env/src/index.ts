import { config as loadDotEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Prefer local overrides while keeping standard .env fallback.
const ENV_FILE_NAMES = [".env.local", ".env"];

/**
 * Build candidate directories to search for env files.
 *
 * Search starts from the current process working directory and then walks up
 * from the caller module location toward parent directories.
 */
function collectSearchDirs(importMetaUrl: string, maxDepth: number) {
  const dirs = new Set<string>();
  dirs.add(process.cwd());

  let currentDir = dirname(fileURLToPath(importMetaUrl));

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    dirs.add(currentDir);
    const parentDir = dirname(currentDir);

    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
  }

  return [...dirs];
}

/**
 * Load the first matching env file and keep existing process values intact.
 * Returns the resolved env file path when loaded.
 */
export function loadRuntimeEnvFile(importMetaUrl: string, maxDepth = 6) {
  for (const dirPath of collectSearchDirs(importMetaUrl, maxDepth)) {
    for (const fileName of ENV_FILE_NAMES) {
      const envPath = resolve(dirPath, fileName);

      if (!existsSync(envPath)) {
        continue;
      }

      loadDotEnv({ path: envPath, override: false });
      return envPath;
    }
  }

  return undefined;
}
