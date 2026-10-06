import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import os from "node:os";
// Manual live experiment: requires existing native provider logins and MidBrain keys.
// No fixture server, credential provisioning, or production persona/profile writes.
if (!process.argv.includes("--live")) {
  console.error("Usage: node scripts/benchmark-memory-priming.mjs --live");
  console.error(
    "Calls real model providers and the production MidBrain API. See docs/testing/pr98-production-validation.md.",
  );
  process.exit(2);
}
const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sdkMcpPath = import.meta.resolve(
  "@modelcontextprotocol/sdk/server/mcp.js",
);
const missingAnchor = "PRIMING-UNRECORDED-" + randomUUID();
const require = createRequire(repo + "/package.json");
const YAML = require("yaml");
const { buildRulesBlock } = await import(repo + "/shared/agent-rules.mjs");
const { shellQuote } = await import(repo + "/shared/clients/shim.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pr98-priming-"));
const temporaryDir = path.join(root, "tmp");
await fs.mkdir(temporaryDir);
await fs.writeFile(
  path.join(temporaryDir, ".midbrain-update-check.json"),
  JSON.stringify({ lastCheck: Date.now() }),
);
console.log(JSON.stringify({ artifactDir: root }));
const preload = root + "/instrument.mjs";
await fs.writeFile(
  preload,
  `import {appendFileSync} from 'node:fs';
import {MidbrainApi} from ${JSON.stringify(repo + "/shared/midbrain-api.mjs")};
import {McpServer} from ${JSON.stringify(sdkMcpPath)};
function audit(o){if(process.env.PR98_AUDIT)appendFileSync(process.env.PR98_AUDIT,JSON.stringify({...o,at:Date.now()})+'\\n',{mode:0o600});}
const create=MidbrainApi.create;MidbrainApi.create=async function(...args){const a=await create.apply(this,args);if(a.effectiveApiBase!=='https://memory.midbrain.ai')throw Error('Benchmark requires production API');return a;};
MidbrainApi.prototype.storeEpisodic=async()=>{};
MidbrainApi.prototype.postEpisodicResult=async()=>({ok:true,status:201});
for(const method of ['getPersona','getProfile']){const original=MidbrainApi.prototype[method];MidbrainApi.prototype[method]=async function(...args){if(process.env.PR98_IDENTITY==='off'){audit({kind:'identity',method,enabled:false});return null;}const t=Date.now();const result=await original.apply(this,args);audit({kind:'identity',method,enabled:true,present:!!result,ms:Date.now()-t});return result;};}
const fetch=globalThis.fetch;globalThis.fetch=async function(u,o){const url=new URL(typeof u==='string'?u:u.url||u);if(url.hostname!=='memory.midbrain.ai')return fetch.call(this,u,o);const method=o?.method||'GET';if(method!=='GET'&&!url.pathname.includes('search'))throw Error('Benchmark blocks production mutations');const t=Date.now();try{const r=await fetch.call(this,u,o);audit({kind:'http',path:url.pathname,method,status:r.status,ms:Date.now()-t});return r;}catch(e){audit({kind:'http',path:url.pathname,method,error:e.name,ms:Date.now()-t});throw e;}};
const tool=McpServer.prototype.tool;McpServer.prototype.tool=function(...args){const name=args[0];if(!['memory_search','grep','list_files','read_file','get_episodic_memories_by_date','check_session_status','memory_diagnostics'].includes(name))return {};const fn=args.pop();args.push(async(...params)=>{audit({kind:'tool',name,args:params[0]});const result=await fn(...params);audit({kind:'tool_result',name,error:!!result.isError,characters:JSON.stringify(result).length});return result;});return tool.apply(this,args);};
`,
);
const entry = root + "/server.mjs";
await fs.writeFile(
  entry,
  `import fs from 'node:fs';Object.assign(process.env,JSON.parse(fs.readFileSync(${JSON.stringify(root)}+'/'+process.env.MIDBRAIN_CLIENT+'/run.json','utf8')));await import(${JSON.stringify(preload)});const {startMcpServer}=await import(${JSON.stringify(repo + "/index.js")});await startMcpServer({prepareCaptureClientMigrationFn:async()=>({}),checkForUpdateFn:()=>{}});`,
);
const tasks = [
  {
    id: "identity",
    anchor: "",
    prompt:
      "Do not use tools, files or memory search. From only Agent persona and User profile supplied in context, give your exact codename and what the user collects. If neither is supplied answer exactly MISSING.",
  },
  {
    id: "decision",
    anchor: "issue #92",
    prompt:
      "Explain the project-subfolder credential binding problem recorded in issue #92 for MidBrain Memory MCP. What caused it, and what behavior was changed? Use the recorded investigation rather than guessing.",
  },
  {
    id: "recovery",
    anchor: "issue #52",
    prompt:
      "Help me assess the cold-start capture problem from issue #52 in MidBrain Memory MCP. What were the two startup races, and how did we address them?",
  },
  {
    id: "missing",
    anchor: missingAnchor,
    prompt: `What rollout decision did we record for ${missingAnchor}? Report only what you can substantiate.`,
  },
];
const reps = Number(process.env.PR98_REPS || 2);
const clients = (process.env.PR98_CLIENTS || "codex,hermes,opencode").split(
  ",",
);
const selected = process.env.PR98_TASK
  ? tasks.filter((t) => t.id === process.env.PR98_TASK)
  : tasks.filter((t) => t.id !== "identity");
if (
  !Number.isInteger(reps) ||
  reps < 1 ||
  reps > 20 ||
  !selected.length ||
  clients.some((c) => !["codex", "hermes", "opencode"].includes(c))
)
  throw Error("Invalid benchmark selection");
for (const client of clients) {
  const dir = root + "/" + client;
  await fs.mkdir(dir);
  await fs.writeFile(
    dir + "/AGENTS.md",
    buildRulesBlock(client === "hermes" ? "hermes" : "agents"),
  );
}
async function config(client) {
  const dir = root + "/" + client;
  const hook = root + "/" + client + "-hook.mjs";
  await fs.writeFile(
    hook,
    `import ${JSON.stringify(preload)};await import(${JSON.stringify(repo + "/plugins/" + (client === "opencode" ? "codex" : client) + "/capture-user.mjs")});`,
  );
  const cmd = shellQuote(process.execPath) + " " + shellQuote(hook);
  const env = {
    ...process.env,
    MIDBRAIN_DEV: "1",
    MIDBRAIN_CLIENT: client,
    MIDBRAIN_LOG_DIR: root + "/logs",
    TMPDIR: temporaryDir,
    TEMP: temporaryDir,
    TMP: temporaryDir,
  };
  delete env.MIDBRAIN_API_URL;
  if (client === "codex") {
    const codexHome = root + "/codex-home";
    await fs.mkdir(codexHome, { recursive: true });
    await fs.symlink(
      process.env.HOME + "/.codex/auth.json",
      codexHome + "/auth.json",
    );
    await fs.writeFile(codexHome + "/AGENTS.md", buildRulesBlock("agents"));
    env.CODEX_HOME = codexHome;
    return {
      env,
      bin: process.env.CODEX_BIN || "codex",
      args: [
        "exec",
        "--ignore-user-config",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--dangerously-bypass-hook-trust",
        "--model",
        "gpt-6-astra",
        "--json",
        "-c",
        "features.hooks=true",
        "-c",
        `hooks.UserPromptSubmit=[{hooks=[{type="command",command=${JSON.stringify(cmd)},timeout=10}]}]`,
        "-c",
        `mcp_servers.midbrain-memory={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(entry)}],env={MIDBRAIN_CLIENT="codex",MIDBRAIN_DEV="1"}}`,
      ],
    };
  }
  if (client === "hermes") {
    const profile =
      process.env.HOME +
      "/.hermes/profiles/pr98-benchmark-" +
      path.basename(root);
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(profile + "/SOUL.md", buildRulesBlock("hermes"));
    await fs.writeFile(
      profile + "/config.yaml",
      YAML.stringify({
        model: { default: "gpt-6-astra", provider: "openai-codex" },
        mcp_servers: {
          "midbrain-memory": {
            command: process.execPath,
            args: [entry],
            env: { MIDBRAIN_CLIENT: "hermes", MIDBRAIN_DEV: "1" },
          },
        },
        hooks: { pre_llm_call: [{ command: cmd, timeout: 30 }] },
      }),
    );
    env.HERMES_HOME = profile;
    return {
      env,
      bin: process.env.HERMES_BIN || "hermes",
      args: [
        "chat",
        "--provider",
        "openai-codex",
        "--model",
        "gpt-6-astra",
        "--in",
        dir,
        "--accept-hooks",
        "--oneshot",
        "-Q",
        "--max-turns",
        "12",
        "--run-budget",
        "100",
        "--format",
        "stream-json",
        "--query",
      ],
    };
  }
  const conf = root + "/config/opencode";
  await fs.mkdir(conf + "/plugins", { recursive: true });
  let plugin = await fs.readFile(
    repo + "/plugins/opencode/midbrain-memory.ts",
    "utf8",
  );
  plugin =
    "import " +
    JSON.stringify(preload) +
    ";\n" +
    plugin.replace(
      '"./midbrain-shared.mjs"',
      JSON.stringify(repo + "/plugins/opencode/midbrain-shared.mjs"),
    );
  await fs.writeFile(conf + "/plugins/midbrain-memory.ts", plugin);
  await fs.writeFile(conf + "/AGENTS.md", buildRulesBlock("agents"));
  await fs.writeFile(
    conf + "/opencode.json",
    JSON.stringify({
      mcp: {
        "midbrain-memory": {
          type: "local",
          command: [process.execPath, entry],
          environment: { MIDBRAIN_CLIENT: "opencode", MIDBRAIN_DEV: "1" },
          enabled: true,
        },
      },
    }),
  );
  env.XDG_CONFIG_HOME = root + "/config";
  env.OPENCODE_CONFIG_DIR = conf;
  return {
    env,
    bin: process.env.OPENCODE_BIN || "opencode",
    args: ["run", "--model", "openai/gpt-6-astra", "--format", "json"],
  };
}
await Promise.all(
  clients.map(async (client) => {
    const cfg = await config(client);
    for (let rep = 0; rep < reps; rep++)
      for (const task of selected)
        for (const identity of rep % 2 ? ["off", "on"] : ["on", "off"]) {
          const id = [client, task.id, rep + 1, identity].join("-");
          const audit = root + "/" + id + ".audit.jsonl";
          await fs.writeFile(
            root + "/" + client + "/run.json",
            JSON.stringify({ PR98_IDENTITY: identity, PR98_AUDIT: audit }),
          );
          const start = Date.now();
          const result = await new Promise((resolve) => {
            const p = spawn(cfg.bin, [...cfg.args, task.prompt], {
              cwd: root + "/" + client,
              env: { ...cfg.env, PR98_IDENTITY: identity, PR98_AUDIT: audit },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "",
              stderr = "";
            p.stdout.on("data", (x) => (stdout += x));
            p.stderr.on("data", (x) => (stderr += x));
            const timer = setTimeout(() => p.kill("SIGKILL"), 125000);
            p.on("error", (e) => (stderr += e.message));
            p.on("close", (code) => {
              clearTimeout(timer);
              resolve({ code, stdout, stderr });
            });
          });
          await fs.writeFile(
            root + "/" + id + ".json",
            JSON.stringify(
              {
                ...result,
                id,
                task,
                identity,
                seconds: (Date.now() - start) / 1000,
              },
              null,
              2,
            ),
            { mode: 0o600 },
          );
          let events = [];
          try {
            events = (await fs.readFile(audit, "utf8"))
              .trim()
              .split("\n")
              .map(JSON.parse);
          } catch {
            /* A failed startup may produce no audit file. */
          }
          const calls = events.filter((e) => e.kind === "tool");
          console.log(
            JSON.stringify({
              id,
              code: result.code,
              seconds: (Date.now() - start) / 1000,
              firstMidbrainTool: calls[0]?.name,
              toolCalls: calls.length,
              identityReads: events.filter((e) => e.kind === "identity"),
              artifact: id + ".json",
            }),
          );
        }
  }),
);
console.log(JSON.stringify({ root }));
