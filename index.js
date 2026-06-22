import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

const z = tool.schema;

const PLUGIN_ID = "opencode-council";
const ADVISOR_AGENT = "council-advisor";
const SETTINGS_FILE = ".opencode-council.json";
const SETTINGS_VERSION = 1;
const DEFAULT_MAX_ADVISORS = 5;
const DEFAULT_PROACTIVE = true;
const DEFAULT_TIMEOUT_MS = 300000;
const MAX_FILE_CHARS = 20000;
const MAX_CONTEXT_CHARS = 70000;
const MAX_DIFF_CHARS = 50000;
const MAX_ADVISOR_OUTPUT_CHARS = 14000;

const DISABLED_ADVISOR_TOOLS = {
  bash: false,
  edit: false,
  patch: false,
  task: false,
  todowrite: false,
  write: false,
  council_ask: false,
};

const ROLE_PRESETS = {
  ask: ["architect", "skeptic", "pragmatist", "researcher", "simplicity"],
  arch: ["architect", "security", "simplicity", "scalability", "maintainability"],
  review: ["reviewer", "security", "maintainability", "performance", "dx"],
  debug: ["debugger", "skeptic", "systems", "observability", "simplicity"],
};

const ROLE_GUIDANCE = {
  architect: "Focus on system design, long-term maintainability, coupling, interfaces, and migration paths.",
  debugger: "Focus on root-cause analysis, reproduction strategy, observability, and the smallest safe fix.",
  maintainability: "Focus on readability, testability, code ownership, future changes, and operational cost.",
  observability: "Focus on logs, traces, metrics, error boundaries, replayability, and debugging visibility.",
  performance: "Focus on latency, throughput, memory, database/query cost, payload size, and hot paths.",
  pragmatist: "Focus on the smallest useful change, delivery risk, existing conventions, and avoiding over-engineering.",
  researcher: "Focus on missing facts, external constraints, alternatives, precedent, and what should be verified before committing.",
  reviewer: "Focus on correctness, regressions, missing tests, edge cases, and concrete review findings.",
  scalability: "Focus on growth paths, bottlenecks, data volume, boundaries, operational scaling, and migration cost.",
  security: "Focus on trust boundaries, credentials, unsafe IO, injection, permissions, and failure modes.",
  simplicity: "Focus on removing unnecessary concepts, flattening control flow, and preserving a minimal API surface.",
  skeptic: "Challenge assumptions, identify weak evidence, point out hidden costs, and argue against the likely default.",
  systems: "Focus on interactions between services, state, retries, timeouts, queues, concurrency, and deployment behavior.",
  dx: "Focus on developer ergonomics, onboarding, configuration, error messages, local workflow, and maintenance friction.",
};

const flexibleStringList = z.union([z.array(z.string()), z.string()]);

function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizeAgent(value, fallback = ADVISOR_AGENT) {
  const agent = asString(value).trim();
  if (!agent || agent === "default" || agent === "auto") return fallback;
  return agent;
}

function asBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function asPositiveInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function stringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function truncate(value, maxChars) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

function formatError(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error.name && error.data?.message) return `${error.name}: ${error.data.message}`;
  if (error.message) return error.message;
  return JSON.stringify(error);
}

async function unwrap(request, label) {
  const result = await request;
  if (result?.error) throw new Error(`${label}: ${formatError(result.error)}`);
  if (!result?.data) throw new Error(`${label}: empty response`);
  return result.data;
}

function parseModelSpec(spec) {
  const value = String(spec || "").trim();
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return {
    providerID: value.slice(0, slash),
    modelID: value.slice(slash + 1),
  };
}

function modelKey(model) {
  return `${model.providerID}/${model.modelID}`;
}

function modelLabel(model) {
  return modelKey(model);
}

function dedupeModels(models) {
  const seen = new Set();
  const result = [];
  for (const model of models) {
    if (!model) continue;
    const key = modelKey(model);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(model);
  }
  return result;
}

function normalizeOptions(options = {}) {
  return {
    agent: normalizeAgent(options.agent),
    includeDiff: asBoolean(options.includeDiff, false),
    maxAdvisors: asPositiveInteger(options.maxAdvisors, DEFAULT_MAX_ADVISORS, 1, DEFAULT_MAX_ADVISORS),
    models: stringList(options.models),
    proactive: options.proactive === undefined ? DEFAULT_PROACTIVE : asBoolean(options.proactive, DEFAULT_PROACTIVE),
    roles: stringList(options.roles),
    timeoutMs: asPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 10000, 900000),
  };
}

function settingsPath(root) {
  return path.join(root, SETTINGS_FILE);
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJsonFile(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function loadProjectDefaults(defaults, context) {
  const settings = await readJsonFile(settingsPath(context.worktree));
  if (!settings || typeof settings !== "object") return defaults;
  return normalizeOptions({ ...defaults, ...settings });
}

function serializableSettings(settings) {
  const clean = normalizeOptions(settings);
  return {
    version: SETTINGS_VERSION,
    models: clean.models,
    roles: clean.roles,
    maxAdvisors: clean.maxAdvisors,
    includeDiff: clean.includeDiff,
    timeoutMs: clean.timeoutMs,
  };
}

function combineToolArgs(args, defaults) {
  const mode = args.mode || "ask";
  return {
    action: args.action || "ask",
    agent: defaults.agent,
    files: stringList(args.files),
    includeDiff: defaults.includeDiff,
    maxAdvisors: defaults.maxAdvisors,
    mode,
    models: defaults.models,
    proactive: defaults.proactive,
    question: asString(args.question).trim(),
    roles: defaults.roles,
    timeoutMs: defaults.timeoutMs,
  };
}

function insideDirectory(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveContextFile(file, context) {
  const absolute = path.resolve(context.directory, file);
  if (!insideDirectory(absolute, context.worktree)) {
    throw new Error(`Refusing to read outside worktree: ${file}`);
  }
  return absolute;
}

async function readContextFiles(files, context) {
  const chunks = [];
  let remaining = MAX_CONTEXT_CHARS;

  for (const file of unique(files)) {
    if (remaining <= 0) break;

    try {
      const absolute = resolveContextFile(file, context);
      const relative = path.relative(context.worktree, absolute) || file;
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) {
        chunks.push(`### ${relative}\n[skipped: not a regular file]`);
        continue;
      }

      const content = await fs.readFile(absolute, "utf8");
      if (content.includes("\0")) {
        chunks.push(`### ${relative}\n[skipped: binary file]`);
        continue;
      }

      const body = truncate(content, Math.min(MAX_FILE_CHARS, remaining));
      chunks.push(`### ${relative}\n\`\`\`\n${body}\n\`\`\``);
      remaining -= body.length;
    } catch (error) {
      chunks.push(`### ${file}\n[error: ${formatError(error)}]`);
    }
  }

  return chunks.join("\n\n");
}

function runReadOnlyCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const maxBufferChars = options.maxBufferChars || MAX_DIFF_CHARS + 10000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, stdout, stderr, message: "timed out" });
    }, options.timeoutMs || 5000);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < maxBufferChars) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < maxBufferChars) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, message: error.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, message: code === 0 ? "ok" : `exit ${code}` });
    });
  });
}

async function gitContext(files, context) {
  const safeFiles = [];
  const fileErrors = [];
  for (const file of unique(files)) {
    try {
      const absolute = resolveContextFile(file, context);
      safeFiles.push(path.relative(context.worktree, absolute));
    } catch (error) {
      fileErrors.push(`${file}: ${formatError(error)}`);
    }
  }

  const status = await runReadOnlyCommand("git", ["-C", context.worktree, "status", "--short"], {
    maxBufferChars: 12000,
    timeoutMs: 5000,
  });
  const diff = files.length && !safeFiles.length
    ? { ok: true, stdout: "[skipped: no valid files]", stderr: "", message: "ok" }
    : await runReadOnlyCommand("git", ["-C", context.worktree, "diff", "--no-ext-diff", "--", ...safeFiles], {
      maxBufferChars: MAX_DIFF_CHARS + 10000,
      timeoutMs: 10000,
    });

  if (!status.ok && !diff.ok) return `Git context unavailable: ${status.message}; ${diff.message}`;

  return [
    "### git status --short",
    "```",
    truncate(status.stdout || status.stderr || status.message, 12000),
    "```",
    ...(fileErrors.length ? ["", "### git file filters skipped", "```", fileErrors.join("\n"), "```"] : []),
    "",
    "### git diff --no-ext-diff",
    "```diff",
    truncate(diff.stdout || diff.stderr || "[empty diff]", MAX_DIFF_CHARS),
    "```",
  ].join("\n");
}

async function collectContext(input, context) {
  const sections = [];
  if (input.files.length) {
    const files = await readContextFiles(input.files, context);
    if (files) sections.push(["## User-Specified Files", files].join("\n\n"));
  }

  if (input.includeDiff || input.mode === "review") {
    const diff = await gitContext(input.files, context);
    if (diff) sections.push(["## Git Context", diff].join("\n\n"));
  }

  return sections.join("\n\n");
}

async function getConfig(client, directory) {
  try {
    return await unwrap(client.config.get({ query: { directory } }), "config.get");
  } catch {
    return {};
  }
}

async function getProviderList(client, directory) {
  try {
    return await unwrap(client.provider.list({ query: { directory } }), "provider.list");
  } catch {
    return null;
  }
}

function modelFromMessageInfo(info) {
  if (info?.model?.providerID && info?.model?.modelID) return info.model;
  if (info?.providerID && info?.modelID) {
    return {
      providerID: info.providerID,
      modelID: info.modelID,
    };
  }
  return null;
}

async function getCurrentMessageModel(client, context) {
  if (!client.session?.message || !context.messageID) return null;

  try {
    const message = await unwrap(
      client.session.message({
        path: { id: context.sessionID, messageID: context.messageID },
        query: { directory: context.directory },
      }),
      "session.message",
    );
    return modelFromMessageInfo(message.info);
  } catch {
    return null;
  }
}

async function getRecentSessionModel(client, context) {
  if (!client.session?.messages) return null;

  try {
    const messages = await unwrap(
      client.session.messages({
        path: { id: context.sessionID },
        query: { directory: context.directory, limit: 20 },
      }),
      "session.messages",
    );
    for (const message of [...messages].reverse()) {
      const model = modelFromMessageInfo(message.info);
      if (model) return model;
    }
  } catch {
    return null;
  }

  return null;
}

async function getAgents(client, directory) {
  try {
    return await unwrap(client.app.agents({ query: { directory } }), "agent.list");
  } catch {
    return [];
  }
}

function agentName(agent) {
  if (typeof agent === "string") return agent;
  return agent?.name || agent?.id || "";
}

function hasAgent(agents, name) {
  return agents.some((agent) => agentName(agent) === name);
}

async function resolveAdvisorAgent(input, client, context) {
  const requested = normalizeAgent(input.agent);
  const agents = await getAgents(client, context.directory);

  if (!agents.length) {
    if (requested === ADVISOR_AGENT) return { ...input, agent: ADVISOR_AGENT, agentNote: "" };
    return {
      ...input,
      agent: ADVISOR_AGENT,
      agentNote: `Advisor agent "${requested}" could not be verified; using "${ADVISOR_AGENT}" instead.`,
    };
  }

  if (hasAgent(agents, requested)) return { ...input, agent: requested, agentNote: "" };

  if (!hasAgent(agents, ADVISOR_AGENT)) {
    throw new Error(`Advisor agent "${requested}" was not found, and fallback "${ADVISOR_AGENT}" is not registered. Restart OpenCode so the plugin config hook can register the advisor agent.`);
  }

  return {
    ...input,
    agent: ADVISOR_AGENT,
    agentNote: `Advisor agent "${requested}" was not found; using "${ADVISOR_AGENT}" instead.`,
  };
}

async function selectModels(input, client, context) {
  const explicit = dedupeModels(input.models.map(parseModelSpec));
  if (explicit.length) return explicit;

  const config = await getConfig(client, context.directory);
  const candidates = [];

  const currentModel = await getCurrentMessageModel(client, context);
  if (currentModel) return [currentModel];

  candidates.push(await getRecentSessionModel(client, context));
  if (config.model) candidates.push(parseModelSpec(config.model));

  return dedupeModels(candidates);
}

function selectRoles(input) {
  const explicit = unique(input.roles);
  if (explicit.length) return explicit;
  return ROLE_PRESETS[input.mode] || ROLE_PRESETS.ask;
}

function buildAdvisorPlan(input, models) {
  const roles = selectRoles(input);
  const count = Math.min(input.maxAdvisors, Math.max(roles.length, models.length, 1));
  const advisors = [];

  for (let index = 0; index < count; index++) {
    advisors.push({
      index: index + 1,
      role: roles[index % roles.length] || "advisor",
      model: models[index % models.length],
    });
  }

  return advisors;
}

function advisorSystemPrompt(role) {
  const guidance = ROLE_GUIDANCE[role] || "Provide a useful independent expert opinion for the coding decision.";
  return [
    `You are the ${role} member of an OpenCode decision council.`,
    guidance,
    "Work independently. Do not try to reach consensus with other members.",
    "Read repository context if needed, but do not edit files, run write commands, or change project state.",
    "Prefer concrete tradeoffs over generic advice.",
  ].join("\n");
}

function advisorPrompt(input, advisor, contextText) {
  const sections = [
    `# Council Request`,
    `Mode: ${input.mode}`,
    `Role: ${advisor.role}`,
    `Working directory: ${contextText ? "context provided below" : "use repository tools if needed"}`,
    "",
    "## Question",
    input.question,
  ];

  if (contextText) sections.push("", contextText);

  sections.push(
    "",
    "## Required Output",
    "Return a concise Markdown answer with:",
    "1. Recommendation",
    "2. Reasoning",
    "3. Risks or counterarguments",
    "4. Verification or next step",
    "5. Confidence: low, medium, or high",
  );

  return sections.join("\n");
}

async function invokeAdvisor(client, context, input, advisor, contextText) {
  const title = `Council ${advisor.index}: ${advisor.role} (${modelLabel(advisor.model)})`;
  const child = await unwrap(
    client.session.create({
      body: { parentID: context.sessionID, title },
      query: { directory: context.directory },
    }),
    "session.create",
  );

  const controller = new AbortController();
  const onAbort = () => controller.abort(context.abort.reason);
  const timer = setTimeout(() => controller.abort(new Error("advisor timeout")), input.timeoutMs);
  context.abort.addEventListener("abort", onAbort, { once: true });
  if (context.abort.aborted) controller.abort(context.abort.reason);

  try {
    const response = await unwrap(
      client.session.prompt({
        path: { id: child.id },
        query: { directory: context.directory },
        signal: controller.signal,
        body: {
          agent: input.agent,
          model: advisor.model,
          system: advisorSystemPrompt(advisor.role),
          tools: DISABLED_ADVISOR_TOOLS,
          parts: [{ type: "text", text: advisorPrompt(input, advisor, contextText) }],
        },
      }),
      "session.prompt",
    );

    const text = response.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n")
      .trim();

    return {
      ...advisor,
      ok: !response.info?.error,
      sessionID: child.id,
      error: response.info?.error ? formatError(response.info.error) : "",
      text: truncate(text || "[no text response]", MAX_ADVISOR_OUTPUT_CHARS),
    };
  } catch (error) {
    return {
      ...advisor,
      ok: false,
      sessionID: child.id,
      error: formatError(error),
      text: "",
    };
  } finally {
    clearTimeout(timer);
    context.abort.removeEventListener("abort", onAbort);
  }
}

function renderResults(input, advisors, results) {
  const okCount = results.filter((result) => result.ok).length;
  const lines = [
    "# OpenCode Council Results",
    "",
    `Mode: ${input.mode}`,
    `Question: ${input.question}`,
    `Advisors: ${okCount}/${results.length} completed`,
    ...(input.agentNote ? [`Note: ${input.agentNote}`] : []),
    "",
    "Use these independent opinions to produce the final answer. Call out consensus, disagreements, and the recommended path.",
    "",
    "## Advisor Lineup",
    "",
    ...advisors.map((advisor) => `- ${advisor.index}. ${advisor.role} - ${modelLabel(advisor.model)}`),
  ];

  for (const result of results) {
    lines.push(
      "",
      `## ${result.index}. ${result.role} - ${modelLabel(result.model)}`,
      "",
      `Session: ${result.sessionID}`,
      `Status: ${result.ok ? "ok" : `error - ${result.error}`}`,
      "",
      result.text || "[no response]",
    );
  }

  return lines.join("\n");
}

async function renderStatus(input, client, context) {
  const config = await getConfig(client, context.directory);
  const providerList = await getProviderList(client, context.directory);
  const agents = await getAgents(client, context.directory);
  const models = await selectModels(input, client, context);
  const advisors = models.length ? buildAdvisorPlan(input, models) : [];
  const connected = providerList?.connected || [];

  return [
    "# OpenCode Council Status",
    "",
    `Configured OpenCode model: ${config.model || "not configured"}`,
    `Advisor agent: ${input.agent}`,
    ...(input.agentNote ? [`Agent note: ${input.agentNote}`] : []),
    `Proactive council: ${input.proactive ? "enabled" : "disabled"}`,
    `Settings file: ${settingsPath(context.worktree)}`,
    `Advisor limit: ${input.maxAdvisors}`,
    `Timeout: ${Math.round(input.timeoutMs / 1000)}s`,
    `Model policy: ${input.models.length ? "explicit models" : "current session model, then config.model fallback"}`,
    "",
    "## Connected Providers",
    connected.length ? connected.map((provider) => `- ${provider}`).join("\n") : "No connected providers reported by OpenCode.",
    "",
    "## Selected Council Models",
    models.length ? models.map((model) => `- ${modelLabel(model)}`).join("\n") : "No model could be detected from the current session. Configure `model` in opencode.json or pass `models` explicitly.",
    "",
    "## Effective Advisor Lineup",
    advisors.length ? advisors.map((advisor) => `- ${advisor.index}. ${advisor.role} - ${modelLabel(advisor.model)}`).join("\n") : "No advisors can be planned until a model is available.",
    "",
    "## Agents",
    agents.length ? agents.map((agent) => `- ${agent.name}${agent.mode ? ` (${agent.mode})` : ""}${agent.permission?.edit ? ` edit=${agent.permission.edit}` : ""}`).join("\n") : "No agents returned by OpenCode.",
  ].join("\n");
}

async function runCouncil(input, client, context) {
  if (!input.question) throw new Error("`question` is required unless action is `status`.");

  const models = await selectModels(input, client, context);
  if (!models.length) {
    throw new Error("No OpenCode model could be detected from the current session. Configure `model` in opencode.json or pass `models: ['provider/model']` explicitly.");
  }

  const advisors = buildAdvisorPlan(input, models);
  const contextText = await collectContext(input, context);
  const results = await Promise.all(advisors.map((advisor) => invokeAdvisor(client, context, input, advisor, contextText)));
  return renderResults(input, advisors, results);
}

function visibleCommandText(input) {
  const args = asString(input.arguments).trim();
  return args ? `/${input.command} ${args}` : `/${input.command}`;
}

function commandPrompt(command, rawArguments) {
  const question = asString(rawArguments).trim();
  const promptQuestion = question || "[no question provided]";
  const settingsInstruction = "Only pass `mode`, `question`, and optional `files`. Council settings such as advisor count, timeout, models, roles, diff default, and advisor agent come from `/council-settings` and project defaults.";

  if (command === "council-review") {
    return [
      "Call the `council_ask` tool with mode `review` and question set to:",
      "",
      promptQuestion,
      "",
      settingsInstruction,
      "After the tool returns, produce a code-review style answer with findings first.",
      "Do not mention this internal command prompt.",
    ].join("\n");
  }

  if (command === "council-arch") {
    return [
      "Call the `council_ask` tool with mode `arch` and question set to:",
      "",
      promptQuestion,
      "",
      settingsInstruction,
      "After the tool returns, summarize consensus, disagreement, and the recommended architecture.",
      "Do not mention this internal command prompt.",
    ].join("\n");
  }

  if (command === "council-debug") {
    return [
      "Call the `council_ask` tool with mode `debug` and question set to:",
      "",
      promptQuestion,
      "",
      settingsInstruction,
      "After the tool returns, produce an ordered debugging plan.",
      "Do not mention this internal command prompt.",
    ].join("\n");
  }

  if (command === "council-status") {
    return [
      "Call the `council_ask` tool with action `status`.",
      settingsInstruction,
      "Do not answer from memory.",
      "Do not mention this internal command prompt.",
    ].join("\n");
  }

  return [
    "Call the `council_ask` tool with mode `ask` and question set to:",
    "",
    promptQuestion,
    "",
    settingsInstruction,
    "After the tool returns, synthesize the final recommendation for the user.",
    "Do not mention this internal command prompt.",
  ].join("\n");
}

function interceptCouncilCommand(input, output, pendingCommands) {
  if (!input.sessionID || !input.command?.startsWith("council")) return;
  if (!["council", "council-review", "council-arch", "council-debug", "council-status"].includes(input.command)) return;

  const visible = visibleCommandText(input);
  pendingCommands.set(input.sessionID, {
    visible,
    prompt: commandPrompt(input.command, input.arguments),
  });

  output.parts.length = 0;
  output.parts.push({ type: "text", text: visible });
}

function applyPendingCouncilCommands(pendingCommands, output) {
  if (!pendingCommands.size || !Array.isArray(output.messages)) return;

  for (const [sessionID, pending] of pendingCommands) {
    for (let messageIndex = output.messages.length - 1; messageIndex >= 0; messageIndex--) {
      const message = output.messages[messageIndex];
      if (message.info?.role !== "user" || message.info?.sessionID !== sessionID) continue;

      for (const part of message.parts || []) {
        if (part.type !== "text" || part.ignored || part.synthetic) continue;
        if (part.text.trim() !== pending.visible.trim()) continue;

        part.text = pending.prompt;
        pendingCommands.delete(sessionID);
        return;
      }
    }
  }
}

function proactiveCouncilPrompt(defaults) {
  const modelPolicy = defaults.models.length
    ? `Use the configured council models: ${defaults.models.join(", ")}.`
    : "Do not pass `models` unless the user explicitly names models; the tool will use the current OpenCode model.";

  return [
    "OpenCode Council proactive policy:",
    "You have access to the `council_ask` tool for getting independent read-only advisor opinions before you answer.",
    "Use it proactively only when the user's request is complex, high-impact, uncertain, or benefits from competing viewpoints.",
    "Good triggers: architecture/API/data-model decisions; security/auth/permissions/secrets; broad refactors; risky code review; complex bugs with multiple plausible root causes; explicit wording like 'compare', 'tradeoff', 'risk', 'architecture', 'security', 'review', 'debug', 'best option', 'как лучше', 'сравни', 'стоит ли', 'решение', 'риски', 'архитектура', 'безопасность'.",
    "Do not use the council for simple factual answers, small obvious edits, formatting, routine commands, or when the user explicitly wants a quick direct answer.",
    "If you call `council_ask`, pass the user's actual question. Use mode `arch` for architecture/tradeoffs, `review` for code-review or risky change review, `debug` for complex debugging, otherwise `ask`.",
    "Only pass `action`, `mode`, `question`, and optional `files`. Council settings such as advisor count, timeout, models, roles, diff default, and advisor agent come from `/council-settings` and project defaults.",
    modelPolicy,
    "After the tool returns, synthesize a final answer for the user. Mention consensus, disagreement, and your recommendation. Do not call the council twice for the same user request unless the first result explicitly needs a targeted follow-up.",
  ].join("\n");
}

function shouldSkipProactivePolicy(system) {
  const text = system.join("\n");
  return [
    "OpenCode decision council",
    "read-only council advisor inside OpenCode",
    "OpenCode Council proactive policy",
    "title generator",
    "conversation summarizer",
  ].some((marker) => text.includes(marker));
}

function injectProactiveCouncilPolicy(defaults, output) {
  if (!defaults.proactive) return;
  if (!Array.isArray(output.system)) return;
  if (shouldSkipProactivePolicy(output.system)) return;

  const prompt = proactiveCouncilPrompt(defaults);
  if (output.system.length) {
    output.system[output.system.length - 1] += `\n\n${prompt}`;
  } else {
    output.system.push(prompt);
  }
}

function registerCommands(config) {
  config.command ||= {};

  config.command.council ||= {
    description: "Ask the OpenCode decision council for independent opinions and synthesize the result.",
    agent: "build",
    template: "",
  };

  config.command["council-review"] ||= {
    description: "Ask the council to review the current change or specified files.",
    agent: "build",
    template: "",
  };

  config.command["council-arch"] ||= {
    description: "Ask the council for architecture tradeoffs and a recommendation.",
    agent: "build",
    template: "",
  };

  config.command["council-debug"] ||= {
    description: "Ask the council for debugging hypotheses and next checks.",
    agent: "build",
    template: "",
  };

  config.command["council-status"] ||= {
    description: "Show OpenCode council models, providers, and agent status.",
    agent: "build",
    template: "",
  };
}

function registerAdvisorAgent(config) {
  config.agent ||= {};
  config.agent[ADVISOR_AGENT] ||= {
    description: "Read-only council member for independent architecture, review, debugging, and tradeoff analysis.",
    mode: "subagent",
    color: "#8B5CF6",
    maxSteps: 8,
    tools: DISABLED_ADVISOR_TOOLS,
    permission: {
      edit: "deny",
      bash: "deny",
      webfetch: "ask",
      doom_loop: "deny",
      external_directory: "ask",
    },
    prompt: [
      "You are a read-only council advisor inside OpenCode.",
      "Give independent, concrete, evidence-aware advice.",
      "Never edit files or run commands that modify project state.",
      "If context is missing, state what you would inspect rather than guessing.",
    ].join("\n"),
  };
}

async function pathExists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

async function findProjectRoot(start = process.cwd()) {
  let current = path.resolve(start);

  while (true) {
    if (
      await pathExists(path.join(current, ".git"))
      || await pathExists(path.join(current, "opencode.json"))
      || await pathExists(path.join(current, "opencode.jsonc"))
      || await pathExists(path.join(current, ".opencode", "opencode.json"))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

function toast(api, message, variant = "info") {
  api.ui.toast({ title: "Council", message, variant });
}

function setDialog(ctx, size, render) {
  ctx.api.ui.dialog.setSize(size);
  ctx.api.ui.dialog.replace(render);
}

async function readTuiSettings(ctx) {
  const settings = await readJsonFile(settingsPath(ctx.projectRoot));
  if (!settings || typeof settings !== "object") return ctx.defaults;
  return normalizeOptions({ ...ctx.defaults, ...settings });
}

async function writeTuiSettings(ctx, settings) {
  await writeJsonFile(settingsPath(ctx.projectRoot), serializableSettings(settings));
}

async function updateTuiSettings(ctx, patch) {
  const current = await readTuiSettings(ctx);
  await writeTuiSettings(ctx, { ...current, ...patch });
}

function showCouncilError(ctx, title, error) {
  setDialog(ctx, "medium", () =>
    ctx.api.ui.DialogAlert({
      title,
      message: error instanceof Error ? error.message : String(error),
      onConfirm: () => showCouncilSettings(ctx),
    }),
  );
}

function showCouncilPrompt(ctx, input) {
  setDialog(ctx, "medium", () =>
    ctx.api.ui.DialogPrompt({
      title: input.title,
      placeholder: input.placeholder,
      value: input.value,
      onConfirm: async (value) => {
        try {
          await input.onConfirm(value);
          toast(ctx.api, "Settings saved", "success");
          await showCouncilSettings(ctx);
        } catch (error) {
          showCouncilError(ctx, input.errorTitle || "Council settings failed", error);
        }
      },
      onCancel: () => showCouncilSettings(ctx),
    }),
  );
}

async function showAdvisorCountPicker(ctx) {
  const settings = await readTuiSettings(ctx);
  setDialog(ctx, "medium", () =>
    ctx.api.ui.DialogSelect({
      title: "Advisor limit",
      current: String(settings.maxAdvisors),
      options: Array.from({ length: DEFAULT_MAX_ADVISORS }, (_, index) => {
        const count = index + 1;
        return {
          title: `${count} advisor${count === 1 ? "" : "s"} max`,
          value: String(count),
          description:
            count <= DEFAULT_MAX_ADVISORS
              ? "core perspectives"
              : "uses all preset roles or selected models when available",
        };
      }),
      onSelect: async (option) => {
        await updateTuiSettings(ctx, { maxAdvisors: Number(option.value) });
        toast(ctx.api, `Advisor limit: ${option.value}`, "success");
        await showCouncilSettings(ctx);
      },
    }),
  );
}

async function unwrapTuiRequest(request, label) {
  const result = await request;
  if (result?.error) throw new Error(`${label}: ${formatError(result.error)}`);
  if (result && "data" in result) return result.data;
  return result;
}

function currentTuiModel(ctx) {
  const route = ctx.api.route?.current;
  const sessionID = route?.name === "session" ? route.params?.sessionID : undefined;
  const sessionModel = sessionID ? ctx.api.state?.session?.get?.(sessionID)?.model : undefined;
  if (sessionModel?.providerID && sessionModel?.id) return `${sessionModel.providerID}/${sessionModel.id}`;

  const configModel = ctx.api.state?.config?.model;
  return typeof configModel === "string" && parseModelSpec(configModel) ? configModel : "";
}

async function getAuthorizedModelOptions(ctx, settings) {
  const data = await unwrapTuiRequest(
    ctx.api.client.provider.list({ directory: ctx.projectRoot }),
    "provider.list",
  );
  const connected = new Set(Array.isArray(data?.connected) ? data.connected : []);
  const providers = Array.isArray(data?.all) ? data.all.filter((provider) => connected.has(provider.id)) : [];
  const selected = new Set(settings.models);

  return providers
    .flatMap((provider) => {
      const models = provider.models && typeof provider.models === "object" ? provider.models : {};
      return Object.entries(models).map(([modelID, model]) => {
        const id = asString(model?.id, modelID);
        const providerID = asString(model?.providerID, provider.id);
        const value = `${providerID}/${id}`;
        const title = model?.name && model.name !== id ? `${model.name} (${id})` : id;
        const details = [provider.name || provider.id];
        if (data?.default?.[provider.id] === id) details.push("provider default");
        if (model?.status) details.push(model.status);
        if (selected.has(value)) details.push("selected");

        return {
          title,
          value,
          category: provider.name || provider.id,
          description: details.join(" · "),
          disabled: selected.has(value),
        };
      });
    })
    .sort((left, right) => {
      const category = String(left.category || "").localeCompare(String(right.category || ""));
      if (category !== 0) return category;
      return left.title.localeCompare(right.title);
    });
}

async function showAuthorizedModelPicker(ctx) {
  const settings = await readTuiSettings(ctx);
  let options;

  try {
    options = await getAuthorizedModelOptions(ctx, settings);
  } catch (error) {
    showCouncilError(ctx, "Could not load authorized models", error);
    return;
  }

  if (!options.length) {
    setDialog(ctx, "medium", () =>
      ctx.api.ui.DialogAlert({
        title: "No authorized models",
        message: "OpenCode did not report any connected providers with models. Authorize a provider in OpenCode first, then reopen /council-settings.",
        onConfirm: () => showModelSettings(ctx),
      }),
    );
    return;
  }

  setDialog(ctx, "xlarge", () =>
    ctx.api.ui.DialogSelect({
      title: "Add council model",
      placeholder: "Search authorized models...",
      options: [
        ...options,
        {
          title: "Back",
          value: "__back",
          category: "Actions",
          description: "Return to council model settings",
        },
      ],
      onSelect: async (option) => {
        if (option.value === "__back") {
          await showModelSettings(ctx);
          return;
        }
        if (option.disabled) return;

        await updateTuiSettings(ctx, { models: unique([...settings.models, option.value]) });
        toast(ctx.api, `Added ${option.value}`, "success");
        await showModelSettings(ctx);
      },
    }),
  );
}

async function showModelSettings(ctx) {
  const settings = await readTuiSettings(ctx);
  const currentModel = currentTuiModel(ctx);
  const selectedModels = settings.models.map((model) => ({
    title: model,
    value: `remove:${model}`,
    category: "Selected models",
    description: "Press Enter to remove this model from the council",
  }));

  setDialog(ctx, "large", () =>
    ctx.api.ui.DialogSelect({
      title: "Council models",
      current: settings.models.length ? undefined : "__current",
      options: [
        {
          title: "Current OpenCode model",
          value: "__current",
          category: "Mode",
          description: currentModel
            ? `${currentModel}; no models are stored in project settings`
            : "Use whichever model the active OpenCode session/config selects",
        },
        {
          title: "Add model",
          value: "__add",
          category: "Actions",
          description: "Choose from models of connected/authorized OpenCode providers only",
        },
        ...selectedModels,
        ...(settings.models.length
          ? [
              {
                title: "Clear selected models",
                value: "__clear",
                category: "Actions",
                description: "Return to current-model mode",
              },
            ]
          : []),
        {
          title: "Back",
          value: "__back",
          category: "Actions",
          description: "Return to council settings",
        },
      ],
      onSelect: async (option) => {
        if (option.value === "__current" || option.value === "__clear") {
          await updateTuiSettings(ctx, { models: [] });
          toast(ctx.api, "Council will use the current OpenCode model", "success");
          await showModelSettings(ctx);
          return;
        }

        if (option.value === "__add") {
          await showAuthorizedModelPicker(ctx);
          return;
        }

        if (option.value === "__back") {
          await showCouncilSettings(ctx);
          return;
        }

        if (typeof option.value === "string" && option.value.startsWith("remove:")) {
          const model = option.value.slice("remove:".length);
          await updateTuiSettings(ctx, { models: settings.models.filter((item) => item !== model) });
          toast(ctx.api, `Removed ${model}`, "success");
          await showModelSettings(ctx);
        }
      },
    }),
  );
}

async function resetCouncilSettings(ctx) {
  try {
    await fs.rm(settingsPath(ctx.projectRoot), { force: true });
    toast(ctx.api, "Council settings reset", "success");
    await showCouncilSettings(ctx);
  } catch (error) {
    showCouncilError(ctx, "Reset failed", error);
  }
}

async function showSettingsPath(ctx) {
  const file = settingsPath(ctx.projectRoot);
  const raw = await readJsonFile(file);
  setDialog(ctx, "large", () =>
    ctx.api.ui.DialogAlert({
      title: "Council settings file",
      message: [
        file,
        "",
        raw ? JSON.stringify(raw, null, 2) : "No project settings saved yet.",
      ].join("\n"),
      onConfirm: () => showCouncilSettings(ctx),
    }),
  );
}

async function showCouncilSettings(ctx) {
  const settings = await readTuiSettings(ctx);
  const modelDescription = settings.models.length
    ? settings.models.join(", ")
    : "default: current OpenCode model, roles rotate on one model";
  const rolesDescription = settings.roles.length
    ? settings.roles.join(", ")
    : "5-role presets per mode; default uses all 5";

  setDialog(ctx, "large", () =>
    ctx.api.ui.DialogSelect({
      title: "Council settings",
      options: [
        {
          title: "Advisor models",
          value: "models",
          description: modelDescription,
        },
        {
          title: "Advisor limit",
          value: "maxAdvisors",
          description: `${settings.maxAdvisors} max; presets provide up to 5 roles`,
        },
        {
          title: "Default roles",
          value: "roles",
          description: rolesDescription,
        },
        {
          title: "Include git diff by default",
          value: "includeDiff",
          description: settings.includeDiff ? "enabled" : "disabled",
        },
        {
          title: "Advisor timeout",
          value: "timeoutMs",
          description: `${Math.round(settings.timeoutMs / 1000)}s per advisor`,
        },
        {
          title: "Settings file",
          value: "path",
          description: settingsPath(ctx.projectRoot),
        },
        {
          title: "Reset project settings",
          value: "reset",
          description: "Return to current OpenCode model + default role presets",
        },
      ],
      footer: "Empty models keeps the default one-model mode. Add models only from connected OpenCode providers.",
      onSelect: async (option) => {
        if (option.value === "models") await showModelSettings(ctx);

        if (option.value === "maxAdvisors") await showAdvisorCountPicker(ctx);

        if (option.value === "roles") {
          showCouncilPrompt(ctx, {
            title: "Default roles",
            placeholder: "architect, skeptic, security; empty = 5-role mode presets",
            value: settings.roles.join(", "),
            onConfirm: async (value) => updateTuiSettings(ctx, { roles: stringList(value) }),
          });
        }

        if (option.value === "includeDiff") {
          await updateTuiSettings(ctx, { includeDiff: !settings.includeDiff });
          toast(ctx.api, `Git diff default ${settings.includeDiff ? "disabled" : "enabled"}`, "success");
          await showCouncilSettings(ctx);
        }

        if (option.value === "timeoutMs") {
          showCouncilPrompt(ctx, {
            title: "Advisor timeout in seconds",
            placeholder: "300",
            value: String(Math.round(settings.timeoutMs / 1000)),
            errorTitle: "Invalid timeout",
            onConfirm: async (value) => {
              const seconds = Number(value);
              if (!Number.isFinite(seconds) || seconds < 10 || seconds > 900) {
                throw new Error("Timeout must be between 10 and 900 seconds.");
              }
              await updateTuiSettings(ctx, { timeoutMs: Math.round(seconds * 1000) });
            },
          });
        }

        if (option.value === "path") await showSettingsPath(ctx);
        if (option.value === "reset") await resetCouncilSettings(ctx);
      },
    }),
  );
}

function buildTuiCommands(ctx) {
  return [
    {
      name: "council.settings",
      title: "Council: settings",
      desc: "Open OpenCode council settings.",
      category: "Council",
      namespace: "palette",
      slashName: "council-settings",
      run: () => showCouncilSettings(ctx),
    },
  ];
}

export const CouncilTuiPlugin = async (api, options = {}) => {
  const ctx = {
    api,
    options: options || {},
    defaults: normalizeOptions(options || {}),
    projectRoot: await findProjectRoot(process.cwd()),
    disposeCommands: undefined,
    registerCommands() {
      if (ctx.disposeCommands) ctx.disposeCommands();
      ctx.disposeCommands = api.keymap.registerLayer({
        priority: 100,
        commands: buildTuiCommands(ctx),
        bindings: [],
      });
    },
  };

  ctx.registerCommands();
  api.lifecycle.onDispose(() => {
    if (ctx.disposeCommands) ctx.disposeCommands();
  });
};

export const CouncilPlugin = async ({ client }, options = {}) => {
  const defaults = normalizeOptions(options);
  const pendingCommands = new Map();

  return {
    config: async (config) => {
      registerCommands(config);
      registerAdvisorAgent(config);
    },
    "command.execute.before": async (input, output) => {
      interceptCouncilCommand(input, output, pendingCommands);
    },
    "experimental.chat.messages.transform": async (input, output) => {
      applyPendingCouncilCommands(pendingCommands, output);
    },
    "experimental.chat.system.transform": async (input, output) => {
      injectProactiveCouncilPolicy(defaults, output);
    },
    tool: {
      council_ask: tool({
        description: "Ask multiple read-only OpenCode model/agent advisors in parallel for complex, high-impact, uncertain, architecture, review, or debugging questions, then return independent opinions for synthesis.",
        args: {
          action: z.enum(["ask", "status"]).optional(),
          files: flexibleStringList.optional(),
          mode: z.enum(["ask", "review", "arch", "debug"]).optional(),
          question: z.string().optional(),
        },
        async execute(args, context) {
          context.metadata({ title: "OpenCode Council" });
          const projectDefaults = await loadProjectDefaults(defaults, context);
          const input = await resolveAdvisorAgent(combineToolArgs(args, projectDefaults), client, context);
          if (input.action === "status") return { title: "OpenCode Council Status", output: await renderStatus(input, client, context) };
          return { title: "OpenCode Council Results", output: await runCouncil(input, client, context) };
        },
      }),
    },
  };
};

export default {
  id: PLUGIN_ID,
  server: CouncilPlugin,
};
