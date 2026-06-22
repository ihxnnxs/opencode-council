#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [command, ...args] = process.argv.slice(2);
const GOLD = "\x1b[38;5;214m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const LOGO = [
  "                        _ _",
  "  ___ ___  _   _ _ __  (_) |",
  " / __/ _ \\| | | | '_ \\ | | |",
  "| (_| (_) | |_| | | | || | |",
  " \\___\\___/ \\__,_|_| |_||_|_|",
  "     opencode decision council",
];

function hasFlag(flag) {
  return args.includes(flag);
}

function packageRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function packageName() {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8"));
  return process.env.OPENCODE_COUNCIL_PACKAGE || manifest.name || "@hxnnxs/opencode-council";
}

function color(text, code) {
  if (process.env.NO_COLOR || process.env.TERM === "dumb" || !process.stdout.isTTY) return text;
  return `${code}${text}${RESET}`;
}

function banner() {
  return LOGO.map((line, index) => color(line, index === LOGO.length - 1 ? DIM : GOLD)).join("\n");
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs || 5000,
    shell: process.platform === "win32",
  });

  if (result.error) return { ok: false, message: result.error.message };
  if ((result.status ?? 1) !== 0) {
    return {
      ok: false,
      message: `exit ${result.status ?? 1}`,
      stderr: (result.stderr || "").trim(),
      stdout: (result.stdout || "").trim(),
    };
  }
  return { ok: true, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
}

function help() {
  console.log(`${banner()}

opencode-council

Usage:
  opencode-council install [--global]
  opencode-council doctor [--json]

Development install from this checkout:
  opencode plugin <path-to-this-checkout>
`);
}

function installCommand() {
  const result = spawnSync("opencode", ["plugin", packageName(), ...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    console.error(`Failed to run opencode: ${result.error.message}`);
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

function doctor() {
  const json = hasFlag("--json");
  const opencode = run("opencode", ["--version"]);
  const payload = {
    package: packageName(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    opencode,
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(
      [
        banner(),
        "",
        "opencode-council doctor",
        "",
        `Package: ${payload.package}`,
        `Node: ${payload.node}`,
        `Platform: ${payload.platform}`,
        `OpenCode: ${opencode.ok ? opencode.stdout || "present" : opencode.message}`,
        ...(opencode.stderr ? [`OpenCode stderr: ${opencode.stderr}`] : []),
      ].join("\n"),
    );
  }

  if (!opencode.ok) process.exitCode = 1;
}

if (command === "install") installCommand();
else if (command === "doctor") doctor();
else help();
