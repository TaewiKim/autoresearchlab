#!/usr/bin/env node
/**
 * Claude Code → Codex CLI argument shim.
 *
 * The Rust harness invokes the per-lane LLM via a "codex"-style
 * subprocess: it accepts flags like ``exec --json --model X --
 * output-last-message PATH``, reads the prompt from stdin, and
 * expects a JSON-event stream on stdout plus a single-message file
 * at the path passed to ``--output-last-message``.
 *
 * Claude Code's CLI does not natively speak that protocol. This
 * shim reads the codex-style invocation, translates it into a
 * ``claude -p "<prompt>" --output-format stream-json`` call, and
 * translates Claude's event stream back into a shape the harness
 * already knows how to consume.
 *
 * Wire it up with::
 *
 *     export RESEARCHLAB_CODEX_CMD=/path/to/claude_codex_shim.sh
 *
 * (the .sh wrapper next to this file invokes ``node`` so the harness's
 * ``Command::new(string)`` only sees a single executable path.)
 */

"use strict";

const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");

function parseFlags(argv) {
  // Mirror just enough of codex's flag set to extract what we need;
  // every other flag is a harmless no-op for Claude.
  const out = {
    model: null,
    outputLastMessage: null,
    outputSchema: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model" && argv[i + 1]) {
      out.model = argv[++i];
    } else if (arg === "--output-last-message" && argv[i + 1]) {
      out.outputLastMessage = argv[++i];
    } else if (arg === "--output-schema" && argv[i + 1]) {
      out.outputSchema = argv[++i];
    }
  }
  return out;
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => resolve(buf));
  });
}

function pickModelArg(model) {
  if (!model) return [];
  // Map a few common codex model names to closest Claude equivalents;
  // anything else is passed through untouched (Claude rejects unknown
  // names with a clear error, which is fine — the user sees it).
  const aliases = {
    "gpt-6.1-sol": "claude-sonnet-4-5",
    "gpt-6.1-terra": "claude-sonnet-4-5",
    "gpt-5.6-sol": "claude-sonnet-4-5",
    "gpt-5.6-terra": "claude-sonnet-4-5",
    "gpt-5.5": "claude-sonnet-4-5",
    "gpt-5.4": "claude-sonnet-4-5",
    "gpt-5.4-mini": "claude-haiku-4-5",
    "gpt-5.3-codex-spark": "claude-sonnet-4-5",
    "codex-agent": "claude-sonnet-4-5",
  };
  const claudeModel = aliases[model] || model;
  return ["--model", claudeModel];
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseFlags(argv);
  const prompt = (await readStdin()).trim();
  if (!prompt) {
    process.stderr.write(
      "claude_codex_shim: empty prompt on stdin; codex contract violated\n",
    );
    process.exit(2);
  }

  // Codex CLI runs each lane in agent mode — it has Bash/Read/Write
  // tools and is expected to write its primary artefacts (graph
  // JSONs, hypothesis state files, analyst-scratch scripts) to disk
  // before exiting. Without those artefacts the next lanes go
  // "deferred awaiting prerequisite". For the Claude shim to be a
  // drop-in replacement we therefore have to enable the same tools
  // and bypass the interactive permission prompts that Claude Code
  // would otherwise raise.
  const claudeArgs = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--allowedTools",
    "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch",
    ...pickModelArg(flags.model),
  ];

  // Notify the harness that this lane is using the Claude shim — the
  // single "thread.started" event makes the on-disk stdout.log
  // diagnosable when something goes wrong inside Claude itself.
  process.stdout.write(
    `${JSON.stringify({ type: "thread.started", driver: "claude_codex_shim", model: flags.model || null })}\n`,
  );

  const child = spawn("claude", claudeArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  let buffer = "";
  let lastAssistantText = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      // Claude Code's stream-json emits ``{type:"assistant", message:{content:[…]}}``
      // and similar; pull text from any content-block whose type is "text".
      if (evt && typeof evt === "object") {
        const message = evt.message || {};
        const blocks = Array.isArray(message.content) ? message.content : [];
        for (const block of blocks) {
          if (block && block.type === "text" && typeof block.text === "string") {
            lastAssistantText = block.text;
          }
        }
        // Forward the event with a codex-style envelope so the harness's
        // existing event reader works without per-driver branching.
        process.stdout.write(
          `${JSON.stringify({ type: "claude.event", event: evt })}\n`,
        );
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  child.on("close", (code) => {
    if (flags.outputLastMessage && lastAssistantText) {
      try {
        fs.mkdirSync(path.dirname(flags.outputLastMessage), { recursive: true });
        fs.writeFileSync(flags.outputLastMessage, lastAssistantText, "utf8");
      } catch (err) {
        process.stderr.write(
          `claude_codex_shim: failed to write output-last-message: ${err.message}\n`,
        );
      }
    }
    process.stdout.write(
      `${JSON.stringify({ type: "thread.completed", exit_code: code, output_chars: lastAssistantText.length })}\n`,
    );
    process.exit(code === null ? 1 : code);
  });
}

main().catch((err) => {
  process.stderr.write(`claude_codex_shim error: ${err && err.message || err}\n`);
  process.exit(1);
});
