/**
 * Agent loop: GPT-5.6-Terra (via 0G Compute) plans browser actions from screenshots.
 *
 * Flow:
 *   1. Take screenshot of current sandbox desktop
 *   2. Send to GPT-5.6-Terra with system prompt + task description
 *   3. LLM returns a structured action (click, type, scroll, done, etc.)
 *   4. Execute action on sandbox (via @e2b/desktop)
 *   5. Repeat until action.type === "done" or maxSteps reached
 *
 * The LLM NEVER runs browser code — it only describes what to do next, and we
 * execute it. Matches the "computer use" agent loop pattern.
 */
import { runVisionInference } from "../og/compute.js";
import { screenshotBase64 } from "../browser/sandbox.js";
import type { Sandbox } from "@e2b/desktop";

/** Actions the LLM can choose from. Wire-compatible with Anthropic Computer Use
 *  (subset) + EVIDIQ extensions (type, scroll_done, extract). */
export type AgentAction =
  | { type: "click"; x: number; y: number; button?: "left" | "right" | "double" }
  | { type: "type"; text: string }
  | { type: "press"; keys: string }
  | { type: "scroll"; direction: "up" | "down"; amount?: number }
  | { type: "wait"; ms?: number }
  | { type: "navigate"; url: string }
  | { type: "screenshot"; reason?: string }
  | { type: "extract"; what: string; selector_hint?: string }
  | { type: "done"; summary: string; result?: unknown };

export type AgentStep = {
  step: number;
  action: AgentAction;
  reasoning?: string;
};

export type AgentLoopResult = {
  steps: AgentStep[];
  finalSummary: string;
  finalScreenshotBase64?: string;
  extractedData?: unknown;
  success: boolean;
  error?: string;
};

const SYSTEM_PROMPT = `You are EVIDIQ Operator — a browser automation agent driving a Linux desktop via XFCE + Chromium.

You receive a screenshot of the current desktop state plus a task description. Decide the SINGLE next action that makes the most progress toward the goal.

Output STRICT JSON only — no markdown, no prose, no code fences, no comments. Use double quotes only (never single quotes). Schema:

{"action": {"type": "click", "x": 123, "y": 456}}
{"action": {"type": "type", "text": "hello"}}
{"action": {"type": "press", "keys": "Enter"}}
{"action": {"type": "scroll", "direction": "down", "amount": 3}}
{"action": {"type": "wait", "ms": 1000}}
{"action": {"type": "navigate", "url": "https://example.com"}}
{"action": {"type": "screenshot"}}
{"action": {"type": "extract", "what": "price + title"}}
{"action": {"type": "done", "summary": "Task complete", "result": {}}}

Rules:
- Coordinates: absolute pixels, top-left origin. Resolution 1024x720.
- Always respond with EXACTLY ONE action object, nothing else.
- When goal achieved: {"action": {"type": "done", "summary": "..."}}
- If page loading/animating: {"action": {"type": "wait", "ms": 800}}
- If submit button not visible after filling fields: scroll down to find it. Submit buttons are usually labeled Submit, Send, Go, Order, or similar.
- If you cannot find a submit button after scrolling, press Enter on the last filled field to submit: {"action": {"type": "press", "keys": "Enter"}}
- For login: if you see a browser native auth dialog (not HTML), close it and report that the site uses HTTP basic auth which requires a different approach.
- Never output markdown fences, never output single quotes.`;

/**
 * Parse the LLM response into a typed action. Lenient: handles single quotes,
 * trailing commas, code fences, leading prose. Throws only on truly invalid JSON.
 */
function parseAction(raw: string): AgentAction {
  // Strip code fences
  let cleaned = raw.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  // Extract outermost {... } block
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  // Fix common LLM JSON mistakes: single quotes → double quotes (keys/values)
  let normalized = cleaned
    .replace(/'/g, '"')           // single → double quotes
    .replace(/,\s*}/g, '}')       // trailing comma
    .replace(/,\s*]/g, ']');      // trailing comma in arrays
  try {
    const obj = JSON.parse(normalized);
    if (!obj || typeof obj !== "object" || !obj.action) {
      throw new Error(`missing .action`);
    }
    return obj.action as AgentAction;
  } catch (e) {
    // Fallback: extract action object via regex (handles nested quotes/braces)
    const m = normalized.match(/"action"\s*:\s*(\{[\s\S]*?\})\s*}/);
    if (m) {
      try {
        // Wrap in outer object for parse
        const inner = JSON.parse(`{"action":${m[1]}}`);
        return inner.action as AgentAction;
      } catch {}
    }
    // Last-ditch: extract via shell-style awk pattern
    const typeM = normalized.match(/"type"\s*:\s*"([a-z_]+)"/);
    if (typeM) {
      const type = typeM[1];
      const xM = normalized.match(/"x"\s*:\s*(\d+)/);
      const yM = normalized.match(/"y"\s*:\s*(\d+)/);
      const textM = normalized.match(/"text"\s*:\s*"([^"]*)"/);
      const urlM = normalized.match(/"url"\s*:\s*"([^"]*)"/);
      const keysM = normalized.match(/"keys"\s*:\s*"([^"]*)"/);
      const sumM = normalized.match(/"summary"\s*:\s*"([^"]*)"/);
      const dirM = normalized.match(/"direction"\s*:\s*"(up|down)"/);
      const whatM = normalized.match(/"what"\s*:\s*"([^"]*)"/);
      const msM = normalized.match(/"ms"\s*:\s*(\d+)/);
      const amtM = normalized.match(/"amount"\s*:\s*(\d+)/);
      const action: Record<string, unknown> = { type };
      if (xM) action.x = Number(xM[1]);
      if (yM) action.y = Number(yM[1]);
      if (textM) action.text = textM[1];
      if (urlM) action.url = urlM[1];
      if (keysM) action.keys = keysM[1];
      if (sumM) action.summary = sumM[1];
      if (dirM) action.direction = dirM[1];
      if (whatM) action.what = whatM[1];
      if (msM) action.ms = Number(msM[1]);
      if (amtM) action.amount = Number(amtM[1]);
      if (type) return action as unknown as AgentAction;
    }
    throw new Error(`Invalid LLM JSON at pos ${normalized.length}: ${(e as Error).message}. Raw after norm: ${normalized.slice(0, 200)}`);
  }
}

/**
 * Run the agent loop until "done" or maxSteps.
 */
export async function runAgentLoop(
  sandbox: Sandbox,
  taskPrompt: string,
  opts: { maxSteps?: number; temperature?: number; onStep?: (s: AgentStep) => void } = {}
): Promise<AgentLoopResult> {
  const maxSteps = opts.maxSteps ?? 20;
  const steps: AgentStep[] = [];
  let lastScreenshot = "";
  let extractedData: unknown;
  let lastActionType = "";
  let lastActionSig = "";
  let repeatCount = 0;
  const MAX_REPEAT = 3;

  for (let step = 1; step <= maxSteps; step++) {
    // 1. Screenshot
    lastScreenshot = await screenshotBase64(sandbox);

    // 2. Ask LLM for next action
    let raw: string;
    try {
      const res = await runVisionInference(
        SYSTEM_PROMPT,
        `Task: ${taskPrompt}\n\nScreenshot attached. Return the next action as JSON.`,
        lastScreenshot,
        { temperature: opts.temperature ?? 0.1, maxTokens: 256 }
      );
      raw = res.content;
    } catch (e) {
      return {
        steps,
        finalSummary: `LLM error at step ${step}`,
        finalScreenshotBase64: lastScreenshot,
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    // 3. Parse + execute
    let action: AgentAction;
    try {
      action = parseAction(raw);
    } catch (e) {
      return {
        steps,
        finalSummary: `Invalid LLM JSON at step ${step}`,
        finalScreenshotBase64: lastScreenshot,
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    const stepRecord: AgentStep = { step, action };
    steps.push(stepRecord);
    opts.onStep?.(stepRecord);
    lastActionType = action.type;

    // Anti-stuck: detect 3 consecutive identical action signatures
    const sig = JSON.stringify(action).replace(/\d+/g, "N"); // treat coords as same
    if (sig === lastActionSig) {
      repeatCount++;
      if (repeatCount >= MAX_REPEAT) {
        return {
          steps,
          finalSummary: `Stopped: same action repeated ${MAX_REPEAT}x (${action.type}). Last screenshot captured.`,
          finalScreenshotBase64: lastScreenshot,
          extractedData,
          success: false,
          error: "stuck_loop_detected",
        };
      }
    } else {
      repeatCount = 0;
      lastActionSig = sig;
    }

    try {
      switch (action.type) {
        case "click":
          await sandbox.leftClick(action.x, action.y);
          if (action.button === "right") await sandbox.rightClick(action.x, action.y);
          if (action.button === "double") await sandbox.doubleClick(action.x, action.y);
          await sandbox.wait(600);
          break;
        case "type":
          await sandbox.write(action.text);
          await sandbox.wait(300);
          break;
        case "press":
          await sandbox.press(action.keys);
          await sandbox.wait(400);
          break;
        case "scroll":
          await sandbox.scroll(action.direction, action.amount ?? 3);
          await sandbox.wait(400);
          break;
        case "wait":
          await sandbox.wait(action.ms ?? 800);
          break;
        case "navigate":
          await sandbox.open(action.url);
          await sandbox.wait(1500);
          break;
        case "screenshot":
          // Take another screenshot and continue (no state change).
          break;
        case "extract": {
          // Run a JS extraction via shell — use Chromium's headless dump-dom if available,
          // otherwise fall back to curl + grep. Return text to the loop as next-step context.
          const script = `python3 -c "
import sys
from urllib.request import urlopen
print(urlopen(sys.argv[1]).read().decode('utf-8', errors='replace')[:20000])
" "${action.selector_hint || ""}" 2>&1 | head -200`;
          try {
            const r = await sandbox.commands.run(script, { timeoutMs: 15_000 });
            extractedData = { what: action.what, rawHtml: r.stdout.slice(0, 8000) };
          } catch {
            extractedData = { what: action.what, error: "extract failed" };
          }
          break;
        }
        case "done":
          return {
            steps,
            finalSummary: action.summary,
            finalScreenshotBase64: lastScreenshot,
            extractedData: action.result ?? extractedData,
            success: true,
          };
      }
    } catch (e) {
      return {
        steps,
        finalSummary: `Execution error at step ${step} (${action.type})`,
        finalScreenshotBase64: lastScreenshot,
        extractedData,
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  return {
    steps,
    finalSummary: `Reached maxSteps (${maxSteps}) without done. Last action: ${lastActionType}`,
    finalScreenshotBase64: lastScreenshot,
    extractedData,
    success: false,
    error: "max_steps_reached",
  };
}
