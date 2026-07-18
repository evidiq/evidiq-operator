/**
 * Browser runtime pool + control wrapper.
 *
 * Strategy: smart idle pool (min 0, max configurable, idle TTL 10 min).
 *- Spawn on demand when pool empty (~1-2s cold start).
 *- Reuse when pool has warm instance (<500ms).
 *- Auto-kill after idle TTL to avoid burn.
 *
 * Env vars (generic, vendor-agnostic — runtime provider is an implementation detail):
 *   BROWSER_API_KEY (fallback: BROWSER_API_KEY, E2B_API_KEY)
 *   BROWSER_TEMPLATE_ID (fallback: BROWSER_TEMPLATE_ID, E2B_TEMPLATE_ID)
 *   BROWSER_RESOLUTION_WIDTH / BROWSER_RESOLUTION_HEIGHT
 *   BROWSER_TIMEOUT_MS
 *   BROWSER_IDLE_TTL_MS
 *   BROWSER_POOL_MAX
 *
 * The actual runtime SDK import (below) is the only place the provider surfaces.
 * Self-hosters who want a different backend swap this file — the rest of the app
 * (server.ts, agent-loop.ts) only depends on the exports of this module.
 */
import { Sandbox } from "@e2b/desktop";

const BROWSER_API_KEY = process.env.BROWSER_API_KEY || process.env.BROWSER_API_KEY || process.env.E2B_API_KEY || "";
const BROWSER_TEMPLATE_ID = process.env.BROWSER_TEMPLATE_ID || process.env.BROWSER_TEMPLATE_ID || process.env.E2B_TEMPLATE_ID || undefined;
const BROWSER_WIDTH = Number(process.env.BROWSER_RESOLUTION_WIDTH || process.env.SANDBOX_RESOLUTION_WIDTH || process.env.E2B_RESOLUTION_WIDTH || 1024);
const BROWSER_HEIGHT = Number(process.env.BROWSER_RESOLUTION_HEIGHT || process.env.SANDBOX_RESOLUTION_HEIGHT || process.env.E2B_RESOLUTION_HEIGHT || 720);
const BROWSER_TIMEOUT_MS = Number(process.env.BROWSER_TIMEOUT_MS || process.env.BROWSER_TIMEOUT_MS || process.env.E2B_TIMEOUT_MS || 300_000);
const BROWSER_IDLE_TTL_MS = Number(process.env.BROWSER_IDLE_TTL_MS || process.env.BROWSER_IDLE_TTL_MS || process.env.E2B_IDLE_TTL_MS || 600_000);
const BROWSER_POOL_MAX = Number(process.env.BROWSER_POOL_MAX || process.env.BROWSER_POOL_MAX || process.env.E2B_POOL_MAX || 100);

if (!BROWSER_API_KEY) {
  console.warn("[browser] BROWSER_API_KEY missing — browser tools will fail at runtime.");
}

type PoolEntry = {
  sandbox: Sandbox;
  idleTimer: NodeJS.Timeout;
  acquiredAt: number;
};

class SandboxPool {
  private pool: PoolEntry[] = [];
  private inFlight = 0;

  async acquire(): Promise<Sandbox> {
    this.inFlight++;
    // Reuse warm sandbox if available
    while (this.pool.length > 0) {
      const entry = this.pool.shift()!;
      clearTimeout(entry.idleTimer);
      try {
        // Lightweight ping: take a 1x1 screenshot to verify alive
        await entry.sandbox.screenshot();
        return entry.sandbox;
      } catch {
        // stale sandbox — drop + spawn fresh
        try { await entry.sandbox.kill(); } catch {}
      }
    }
    // Cold spawn
    return this.spawn();
  }

  private async spawn(): Promise<Sandbox> {
    const opts = {
      apiKey: BROWSER_API_KEY,
      resolution: [BROWSER_WIDTH, BROWSER_HEIGHT] as [number, number],
      dpi: 96,
      timeoutMs: BROWSER_TIMEOUT_MS,
    };
    if (BROWSER_TEMPLATE_ID) {
      return (Sandbox as unknown as {
        create(template: string, opts?: unknown): Promise<Sandbox>;
      }).create(BROWSER_TEMPLATE_ID, opts);
    }
    return (Sandbox as unknown as {
      create(opts?: unknown): Promise<Sandbox>;
    }).create(opts);
  }

  /**
   * Release a sandbox back to the pool. Resets browser state (close tabs,
   * clear cookies) so the next acquirer gets a clean desktop.
   */
  async release(sandbox: Sandbox): Promise<void> {
    this.inFlight = Math.max(0, this.inFlight - 1);
    try {
      // Reset: close any open windows + kill chromium processes
      await sandbox.commands.run(
        "pkill -f chromium || true; pkill -f firefox || true; rm -rf /home/user/.cache/chromium /home/user/.cache/mozilla 2>/dev/null || true"
      );
    } catch {
      // ignore cleanup errors
    }

    if (this.pool.length >= BROWSER_POOL_MAX) {
      try { await sandbox.kill(); } catch {}
      return;
    }

    const idleTimer = setTimeout(() => this.kill(sandbox), BROWSER_IDLE_TTL_MS);
    this.pool.push({ sandbox, idleTimer, acquiredAt: Date.now() });
  }

  private async kill(sandbox: Sandbox): Promise<void> {
    const idx = this.pool.findIndex((e) => e.sandbox === sandbox);
    if (idx >= 0) {
      const entry = this.pool.splice(idx, 1)[0];
      clearTimeout(entry.idleTimer);
    }
    try { await sandbox.kill(); } catch {}
  }

  /** For /health + /capabilities: pool telemetry. */
  stats() {
    return {
      warm: this.pool.length,
      inFlight: this.inFlight,
      max: BROWSER_POOL_MAX,
      idleTtlMs: BROWSER_IDLE_TTL_MS,
      templateId: BROWSER_TEMPLATE_ID || "default-desktop",
      resolution: [BROWSER_WIDTH, BROWSER_HEIGHT],
    };
  }

  /** Best-effort cleanup on shutdown. */
  async drain(): Promise<void> {
    const entries = this.pool.splice(0);
    await Promise.all(
      entries.map(async (e) => {
        clearTimeout(e.idleTimer);
        try { await e.sandbox.kill(); } catch {}
      })
    );
  }
}

export const sandboxPool = new SandboxPool();

/**
 * Run a one-shot task inside a sandbox. Auto-acquires + releases.
 * Returns whatever `fn` returns.
 */
export async function withSandbox<T>(
  fn: (sandbox: Sandbox) => Promise<T>
): Promise<T> {
  const sandbox = await sandboxPool.acquire();
  try {
    return await fn(sandbox);
  } finally {
    await sandboxPool.release(sandbox);
  }
}

/**
 * Take a screenshot as a base64 PNG string (for LLM vision input).
 */
export async function screenshotBase64(sandbox: Sandbox): Promise<string> {
  const bytes = await sandbox.screenshot();
  return Buffer.from(bytes).toString("base64");
}

/**
 * Open a URL in the default browser inside the sandbox.
 */
export async function navigate(sandbox: Sandbox, url: string): Promise<void> {
  await sandbox.open(url);
  // Give browser time to render before next screenshot
  await sandbox.wait(1500);
}

/**
 * Write text into the currently focused field (e.g. after clicking an input).
 */
export async function typeText(sandbox: Sandbox, text: string): Promise<void> {
  await sandbox.write(text);
}

/**
 * Press a key or combination (e.g. "Enter", "Control+a").
 */
export async function pressKey(sandbox: Sandbox, key: string): Promise<void> {
  await sandbox.press(key);
}

/**
 * Click at coordinates (x, y) — left click by default.
 */
export async function click(
  sandbox: Sandbox,
  x: number,
  y: number,
  button: "left" | "right" | "middle" | "double" = "left"
): Promise<void> {
  switch (button) {
    case "right": await sandbox.rightClick(x, y); break;
    case "middle": await sandbox.middleClick(x, y); break;
    case "double": await sandbox.doubleClick(x, y); break;
    default: await sandbox.leftClick(x, y);
  }
}

/**
 * Scroll the page.
 */
export async function scroll(
  sandbox: Sandbox,
  direction: "up" | "down",
  amount = 3
): Promise<void> {
  await sandbox.scroll(direction, amount);
}

/**
 * Run a shell command inside the sandbox (e.g. `curl`, `wget`, file ops).
 */
export async function shell(
  sandbox: Sandbox,
  command: string,
  timeoutMs = 60_000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await sandbox.commands.run(command, { timeoutMs });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.exitCode ?? 0,
  };
}

/**
 * Download a file via the sandbox's browser, then read it back as bytes.
 * Uses `wget` inside the sandbox for reliability (Chromium downloads are
 * async + hard to wait on). For sites requiring JS rendering, use a browser
 * workflow + read from /home/user/Downloads.
 */
export async function downloadFile(
  sandbox: Sandbox,
  url: string,
  destPath = `/home/user/Downloads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
): Promise<{ path: string; bytes: Buffer; size: number }> {
  const r = await sandbox.commands.run(`wget -q -O "${destPath}" "${url}" && stat -c %s "${destPath}"`);
  const size = Number(r.stdout.trim()) || 0;
  // Read file bytes via cat (filesystem API not in desktop SDK types; shell works reliably)
  const catResult = await sandbox.commands.run(`base64 "${destPath}"`, { timeoutMs: 15_000 });
  const fileBytes = Buffer.from(catResult.stdout, "base64");
  return { path: destPath, bytes: fileBytes, size };
}
