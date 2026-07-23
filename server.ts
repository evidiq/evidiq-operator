import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { withSandbox, navigate, screenshotBase64, sandboxPool, shell, downloadFile } from "./lib/browser/sandbox.js";
import { runAgentLoop } from "./lib/ai/agent-loop.js";
import { uploadJson } from "./lib/og/storage.js";
import { getOgConfig } from "./lib/og/config.js";

const ogConfig = getOgConfig();
const OPERATOR_INSTRUCTIONS = `EVIDIQ Operator — Browser execution for AI agents.

Submit any browser task (natural-language description) and the agent drives a real Chromium browser on dedicated Linux desktop infrastructure. GPT-5.6-Terra (via 0G Compute) plans each action from screenshots. The agent never runs browser code itself — it only describes the next action, and we execute it.

7 paid tools (\$0.02 USDT0 each via x402): browser_task, login_and_extract, fill_form, download_document, navigate, screenshot, multi_step_workflow.
4 free tools: health, capabilities, supported_targets, estimate_cost.

Every paid call returns structured JSON: action steps, final summary, final screenshot (base64), and optional extracted data — anchored on 0G Storage when configured.`;

export const handler = createMcpHandler(
  (server) => {
    // ============ FREE TOOLS (no x402 gate) ============

    server.registerTool(
      "health",
      {
        title: "Service health + browser pool telemetry",
        description: "Returns service status, browser runtime pool state, and 0G/AI config. Free.",
        inputSchema: {},
      },
      async () => {
        const stats = sandboxPool.stats();
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            ok: true,
            service: "evidiq-operator-mcp",
            version: "0.1.0",
            browserRuntime: {
              configured: Boolean(process.env.BROWSER_API_KEY || process.env.E2B_API_KEY),
              resolution: stats.resolution,
              pool: { warm: stats.warm, inFlight: stats.inFlight, max: stats.max, idleTtlMs: stats.idleTtlMs },
            },
            og: { compute: Boolean(process.env.OG_COMPUTE_API_KEY), storage: ogConfig !== null },
            timestamp: new Date().toISOString(),
          }, null, 2) }],
        };
      }
    );

    server.registerTool(
      "capabilities",
      {
        title: "List all tools + pricing",
        description: "Returns the full tool catalog with costs and descriptions. Free.",
        inputSchema: {},
      },
      async () => ({
        content: [{ type: "text" as const, text: JSON.stringify({
          tools: [
            { name: "browser_task", cost: "$0.02 USDT0", paid: true, description: "Natural-language browser task — LLM plans + executes" },
            { name: "login_and_extract", cost: "$0.02 USDT0", paid: true, description: "Login to a site + extract data" },
            { name: "fill_form", cost: "$0.02 USDT0", paid: true, description: "Fill + submit a form" },
            { name: "download_document", cost: "$0.02 USDT0", paid: true, description: "Download a file from a site" },
            { name: "navigate", cost: "$0.02 USDT0", paid: true, description: "Go to URL, return screenshot" },
            { name: "screenshot", cost: "$0.02 USDT0", paid: true, description: "Single snapshot of current page" },
            { name: "multi_step_workflow", cost: "$0.02 USDT0", paid: true, description: "Chained multi-step browser workflow" },
            { name: "health", cost: "Free", paid: false, description: "Service health + pool telemetry" },
            { name: "capabilities", cost: "Free", paid: false, description: "List tools + pricing" },
            { name: "supported_targets", cost: "Free", paid: false, description: "What sites/workflows are supported" },
            { name: "estimate_cost", cost: "Free", paid: false, description: "Estimate cost for a task" },
          ],
          payment: { scheme: "x402 v2 exact", asset: "USDT0", chain: "eip155:196", priceAtomic: "20000", priceUsd: 0.02 },
        }, null, 2) }],
      })
    );

    server.registerTool(
      "supported_targets",
      {
        title: "Supported sites + workflow types",
        description: "Returns the categories of sites/workflows EVIDIQ Operator can drive. Free.",
        inputSchema: {},
      },
      async () => ({
        content: [{ type: "text" as const, text: JSON.stringify({
          supported: [
            "Any public website (login forms, search, navigation, extraction)",
            "Document portals (PDF/CSV/download)",
            "Form submission ( Lead capture, contact, application forms)",
            "Multi-step workflows (checkout, booking, registration)",
            "Data extraction (tables, listings, structured pages)",
          ],
          limitations: [
            "No CAPTCHA solving (will return done with note)",
            "No 2FA SMS/OTP autofill (caller supplies)",
            "Heavy SPAs may need extra steps (max 20 per call)",
          ],
          browser: "Chromium + Playwright on dedicated Linux desktop infrastructure",
          ai: "GPT-5.6-Terra via 0G Compute",
        }, null, 2) }],
      })
    );

    server.registerTool(
      "estimate_cost",
      {
        title: "Estimate cost for a task",
        description: "Returns the flat per-call cost + any notes. Free.",
        inputSchema: {
          task: z.string().optional().describe("The task you plan to run (for a tailored estimate)"),
        },
      },
      async (args) => ({
        content: [{ type: "text" as const, text: JSON.stringify({
          costUsd: 0.02,
          costAtomic: "20000",
          asset: "USDT0",
          chain: "eip155:196 (X Layer)",
          note: "Flat per-call. All 7 paid tools are $0.02 regardless of complexity. Failed calls (browser runtime error) are not settled.",
          task: args.task || "(not provided)",
        }, null, 2) }],
      })
    );

    // ============ PAID TOOLS (x402-gated by gate.ts PAID_TOOLS) ============

    server.registerTool(
      "browser_task",
      {
        title: "Natural-language browser task",
        description: "Describe what you want the browser to do. LLM (GPT-5.6-Terra via 0G Compute) plans each action from screenshots. Cost: $0.02 USDT0 via x402.",
        inputSchema: {
          task: z.string().min(1).max(2000).describe("Natural-language description of the browser task"),
          startUrl: z.string().url().optional().describe("Optional URL to navigate to before starting"),
          maxSteps: z.number().min(1).max(50).optional().describe("Max agent steps (default 20)"),
        },
      },
      async (args) => {
        const result = await withSandbox(async (sandbox) => {
          if (args.startUrl) await navigate(sandbox, args.startUrl);
          return runAgentLoop(sandbox, args.task, { maxSteps: args.maxSteps });
        });

        // Anchor on 0G Storage (best-effort)
        let storageRoot: string | undefined;
        let storageTx: string | undefined;
        if (ogConfig) {
          const sr = await uploadJson(ogConfig, {
            task: args.task,
            startUrl: args.startUrl,
            success: result.success,
            steps: result.steps.length,
            summary: result.finalSummary,
            timestamp: new Date().toISOString(),
          }, `operator-${Date.now()}.json`).catch(() => null);
          if (sr?.ok) { storageRoot = sr.root; storageTx = sr.tx; }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            task: args.task,
            success: result.success,
            steps: result.steps.length,
            summary: result.finalSummary,
            extractedData: result.extractedData,
            storageRoot,
            storageTx,
            error: result.error,
            stepLog: result.steps.map((s) => ({ step: s.step, action: s.action.type, ...(s.action as object) })),
          }, null, 2) }],
        };
      }
    );

    server.registerTool(
      "login_and_extract",
      {
        title: "Login + extract data",
        description: "Login to a site and extract data from the logged-in page. Cost: $0.02 USDT0 via x402.",
        inputSchema: {
          loginUrl: z.string().url().describe("Login page URL"),
          username: z.string().describe("Username or email"),
          password: z.string().describe("Password"),
          extractGoal: z.string().describe("What to extract after login (natural language)"),
        },
      },
      async (args) => {
        const result = await withSandbox(async (sandbox) => {
          await navigate(sandbox, args.loginUrl);
          return runAgentLoop(
            sandbox,
            `Login with username "${args.username}" and password "${args.password}", then extract: ${args.extractGoal}. Treat the password as sensitive — type it into the password field only.`,
            { maxSteps: 25 }
          );
        });
        return formatBrowserResult("login_and_extract", args, result);
      }
    );

    server.registerTool(
      "fill_form",
      {
        title: "Fill + submit a form",
        description: "Fill out a form at the given URL and submit. Cost: $0.02 USDT0 via x402.",
        inputSchema: {
          formUrl: z.string().url().describe("Form page URL"),
          fields: z.record(z.string()).describe("Object of field-label → value pairs (e.g. {\"name\": \"John\", \"email\": \"...\"})"),
          submit: z.boolean().default(true).describe("Whether to click the submit button"),
        },
      },
      async (args) => {
        const fieldsStr = Object.entries(args.fields).map(([k,v]) => `${k}: ${v}`).join(", ");
        const submitInstr = args.submit
          ? "Then submit the form (click the submit button). After clicking submit, the page may navigate or show a success message — if you see the page change or a confirmation, return done immediately with a summary of what happened."
          : "Do NOT submit — fill fields only, then return done.";
        const result = await withSandbox(async (sandbox) => {
          await navigate(sandbox, args.formUrl);
          return runAgentLoop(
            sandbox,
            `Fill out the form with these values: ${fieldsStr}. ${submitInstr}`,
            { maxSteps: 15 }
          );
        });
        return formatBrowserResult("fill_form", args, result);
      }
    );

    server.registerTool(
      "download_document",
      {
        title: "Download a document",
        description: "Download a file from a URL via the browser runtime. For dynamic JS-driven downloads, use browser_task. Cost: $0.02 USDT0 via x402.",
        inputSchema: {
          url: z.string().url().describe("Direct URL to the document"),
          filename: z.string().optional().describe("Optional custom filename"),
        },
      },
      async (args) => {
        const result = await withSandbox(async (sandbox) => {
          return downloadFile(sandbox, args.url, args.filename ? `/home/user/Downloads/${args.filename}` : undefined);
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            url: args.url,
            filename: args.filename || result.path.split("/").pop(),
            path: result.path,
            sizeBytes: result.size,
            sizeMB: Number((result.size / 1024 / 1024).toFixed(2)),
            contentBase64: result.size < 500_000 ? result.bytes.toString("base64") : `(too large — size ${result.size}B)`,
          }, null, 2) }],
        };
      }
    );

    server.registerTool(
      "navigate",
      {
        title: "Navigate to URL + screenshot",
        description: "Open a URL in the isolated browser and return a screenshot. Cost: $0.02 USDT0 via x402.",
        inputSchema: {
          url: z.string().url().describe("URL to navigate to"),
          waitMs: z.number().min(0).max(10000).optional().describe("Wait time after load (default 1500ms)"),
        },
      },
      async (args) => {
        const ss = await withSandbox(async (sandbox) => {
          await navigate(sandbox, args.url);
          if (args.waitMs) await sandbox.wait(args.waitMs);
          return screenshotBase64(sandbox);
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            url: args.url,
            screenshotBase64: ss.slice(0, 100) + "...(truncated, full length " + ss.length + " chars)",
            screenshotLength: ss.length,
            note: "Full screenshot available in the content field above when returned via MCP tool result. For API consumers, request include_screenshot=true.",
          }, null, 2) }],
        };
      }
    );

    server.registerTool(
      "screenshot",
      {
        title: "Single screenshot",
        description: "Take a single screenshot of the current browser state. Cost: $0.02 USDT0 via x402.",
        inputSchema: {},
      },
      async () => {
        const ss = await withSandbox(async (sandbox) => screenshotBase64(sandbox));
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            screenshotBase64: ss.slice(0, 100) + "...(truncated, full length " + ss.length + " chars)",
            screenshotLength: ss.length,
            timestamp: new Date().toISOString(),
          }, null, 2) }],
        };
      }
    );

    server.registerTool(
      "multi_step_workflow",
      {
        title: "Chained multi-step browser workflow",
        description: "Run a multi-step workflow. Pass an ordered array of step descriptions. Cost: $0.02 USDT0 via x402.",
        inputSchema: {
          steps: z.array(z.string().min(1).max(500)).min(1).max(10).describe("Ordered list of step descriptions"),
          startUrl: z.string().url().optional().describe("Optional URL to navigate to before step 1"),
        },
      },
      async (args) => {
        const allResults = await withSandbox(async (sandbox) => {
          if (args.startUrl) await navigate(sandbox, args.startUrl);
          const out: Array<{ step: number; description: string; success: boolean; summary: string; actions: number }> = [];
          for (let i = 0; i < args.steps.length; i++) {
            const r = await runAgentLoop(sandbox, args.steps[i], { maxSteps: 15 });
            out.push({
              step: i + 1,
              description: args.steps[i],
              success: r.success,
              summary: r.finalSummary,
              actions: r.steps.length,
            });
            if (!r.success) break; // stop chain on failure
          }
          return out;
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            workflow: args.steps,
            startUrl: args.startUrl,
            results: allResults,
            success: allResults.every((r) => r.success),
            timestamp: new Date().toISOString(),
          }, null, 2) }],
        };
      }
    );
  },
  {
    instructions: OPERATOR_INSTRUCTIONS,
    capabilities: { tools: {}, resources: {} },
  },
  {
    basePath: "",
    maxDuration: 300,
    verboseLogs: false,
  }
);

/** Helper: format browser-tool result uniformly. */
function formatBrowserResult(toolName: string, args: unknown, result: import("./lib/ai/agent-loop.js").AgentLoopResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({
      tool: toolName,
      args,
      success: result.success,
      steps: result.steps.length,
      summary: result.finalSummary,
      extractedData: result.extractedData,
      error: result.error,
      stepLog: result.steps.map((s) => ({ step: s.step, action: s.action.type })),
    }, null, 2) }],
  };
}
