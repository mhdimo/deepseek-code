





















import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir, userInfo } from "os";




const DATA_DIR = join(homedir(), ".deepseek-code");


const SECRETS_FILE = join(DATA_DIR, "secrets.json");


const KEYCHAIN_SERVICE = "DeepSeek-Code";


const KEYCHAIN_TIMEOUT_MS = 10_000;



function isMacOS(): boolean {
  return process.platform === "darwin";
}


function getUsername(): string {
  try {
    return process.env.USER || process.env.LOGNAME || userInfo().username || "deepseek-code-user";
  } catch {
    return "deepseek-code-user";
  }
}


function serviceName(name: string): string {
  return `${KEYCHAIN_SERVICE}:${name}`;
}


function toHex(value: string): string {
  return Buffer.from(value, "utf-8").toString("hex");
}


function runSecurity(args: string[], expectNotFound = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {  }
      reject(new Error("security command timed out"));
    }, KEYCHAIN_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to spawn 'security': ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const trimmed = stdout.trim();
      if (code === 0) {
        resolve(trimmed);
      } else if (code === 44 && expectNotFound) {
        resolve("");
      } else {
        reject(new Error(`security ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
      }
    });

    child.stdin.end();
  });
}


function runSecuritySync(args: string[], expectNotFound = false): string {
  const result = spawnSync("security", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: KEYCHAIN_TIMEOUT_MS,
    input: "",
  });
  if (result.error) {
    throw new Error(`Failed to spawn 'security': ${result.error.message}`);
  }
  const code = result.status ?? -1;
  if (code === 0) return (result.stdout || "").trim();
  if (code === 44 && expectNotFound) return "";
  throw new Error(`security ${args.join(" ")} exited ${code}: ${(result.stderr || "").trim()}`);
}



interface SecretsFile {
  [name: string]: string;
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readFallbackStore(): SecretsFile {
  try {
    if (!existsSync(SECRETS_FILE)) return {};
    const raw = readFileSync(SECRETS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SecretsFile;
    }
    return {};
  } catch {
    return {};
  }
}

function writeFallbackStore(data: SecretsFile): void {
  ensureDataDir();
  
  
  writeFileSync(SECRETS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    chmodSync(SECRETS_FILE, 0o600);
  } catch {
    
  }
}




export async function getSecret(name: string): Promise<string> {
  if (!name) return "";

  if (isMacOS()) {
    try {
      
      
      return await runSecurity(
        ["find-generic-password", "-a", getUsername(), "-s", serviceName(name), "-w"],
        true,
      );
    } catch {
      
      
      
    }
  }

  return readFallbackStore()[name] ?? "";
}


export async function setSecret(name: string, value: string): Promise<boolean> {
  if (!name) return false;

  if (isMacOS()) {
    try {
      
      
      await runSecurity([
        "add-generic-password",
        "-U",                          
        "-a", getUsername(),           
        "-s", serviceName(name),       
        "-X", toHex(value),            
      ]);
      return true;
    } catch {
      
    }
  }

  try {
    const store = readFallbackStore();
    store[name] = value;
    writeFallbackStore(store);
    return true;
  } catch {
    return false;
  }
}


export async function deleteSecret(name: string): Promise<boolean> {
  if (!name) return false;

  if (isMacOS()) {
    try {
      await runSecurity(
        ["delete-generic-password", "-a", getUsername(), "-s", serviceName(name)],
        true,
      );
      
      removeFromFallbackStore(name);
      return true;
    } catch {
      
    }
  }

  return removeFromFallbackStore(name);
}


function removeFromFallbackStore(name: string): boolean {
  try {
    const store = readFallbackStore();
    if (!(name in store)) return true; 
    delete store[name];
    writeFallbackStore(store);
    return true;
  } catch {
    return false;
  }
}









export function getSecretSync(name: string): string {
  if (!name) return "";
  if (isMacOS()) {
    try {
      
      
      return runSecuritySync(
        ["find-generic-password", "-a", getUsername(), "-s", serviceName(name), "-w"],
        true,
      );
    } catch {
      
    }
  }
  return readFallbackStore()[name] ?? "";
}


export function setSecretSync(name: string, value: string): boolean {
  if (!name) return false;
  if (isMacOS()) {
    try {
      runSecuritySync([
        "add-generic-password",
        "-U",
        "-a", getUsername(),
        "-s", serviceName(name),
        "-X", toHex(value),
      ]);
      return true;
    } catch {
      
    }
  }
  try {
    const store = readFallbackStore();
    store[name] = value;
    writeFallbackStore(store);
    return true;
  } catch {
    return false;
  }
}


export function deleteSecretSync(name: string): boolean {
  if (!name) return false;
  if (isMacOS()) {
    try {
      runSecuritySync(
        ["delete-generic-password", "-a", getUsername(), "-s", serviceName(name)],
        true,
      );
      removeFromFallbackStore(name);
      return true;
    } catch {
      
    }
  }
  return removeFromFallbackStore(name);
}




export function clearPlaintextSecrets(): boolean {
  try {
    if (existsSync(SECRETS_FILE)) unlinkSync(SECRETS_FILE);
    return true;
  } catch {
    return false;
  }
}


export function getSecretsFilePath(): string {
  return SECRETS_FILE;
}


export function getKeychainService(): string {
  return KEYCHAIN_SERVICE;
}


export function getKeychainServiceName(name: string): string {
  return serviceName(name);
}
