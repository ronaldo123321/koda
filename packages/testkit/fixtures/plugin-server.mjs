import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [name, ...value] = argument.replace(/^--/u, "").split("=");
    return [name, value.join("=") || "true"];
  }),
);
const mode = options.mode ?? "normal";
const version = options.version ?? "1.0.0";
const exitFile = process.env.KODA_PLUGIN_EXIT_FILE;

if (exitFile) {
  process.once("exit", () => appendFileSync(exitFile, "closed\n"));
}
if (mode !== "normal") {
  process.on("SIGTERM", () => {
    if (exitFile) {
      appendFileSync(exitFile, "terminated\n");
    }
    process.exit(0);
  });
}
if (mode === "ignore-shutdown") {
  setInterval(() => undefined, 1_000);
}

process.stderr.write(
  `plugin diagnostic ${process.env.KODA_PLUGIN_ALLOWED ?? "no-secret"}\n`,
);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    if (mode === "hang-init") {
      return;
    }
    if (mode === "hostile-init") {
      process.stdout.write("not-json\n");
      return;
    }
    respond(request.id, {
      protocolVersion: mode === "bad-version" ? 999 : 1,
      plugin: { name: "Koda fixture plugin", version },
      contributions: {
        tools: [
          definition("echo", "Echo one value."),
          definition("environment", "Inspect the filtered environment."),
        ],
        skills: [
          {
            name: "plugin-helper",
            content:
              "---\nname: plugin-helper\ndescription: Guidance supplied by the fixture plugin.\n---\nUse plugin tools through normal Koda policy.\n",
          },
        ],
        command_templates: [
          {
            name: "plugin-greet",
            content:
              '---\nname: plugin-greet\ndescription: Greet one target from a plugin template.\nparameters: [{"name":"target","description":"Target name.","type":"string","required":true,"max_bytes":128}]\n---\nHello {{target}} from the plugin.\n',
          },
        ],
      },
    });
    return;
  }
  if (request.method === "tool/call") {
    if (mode === "hang-call") {
      return;
    }
    if (request.params.name === "echo") {
      respond(request.id, {
        echoed: request.params.arguments.value,
        definition_sha256: request.params.definitionSha256,
        allowed_secret: process.env.KODA_PLUGIN_ALLOWED ?? null,
        forbidden_present: process.env.KODA_PLUGIN_FORBIDDEN !== undefined,
      });
      return;
    }
    if (request.params.name === "environment") {
      respond(request.id, {
        allowed_secret: process.env.KODA_PLUGIN_ALLOWED ?? null,
        forbidden_present: process.env.KODA_PLUGIN_FORBIDDEN !== undefined,
      });
      return;
    }
    respondError(request.id, -32601, "Unknown fixture tool.");
    return;
  }
  if (request.method === "shutdown") {
    respond(request.id, {});
    if (mode !== "ignore-shutdown") {
      setImmediate(() => process.exit(0));
    }
    return;
  }
  respondError(request.id, -32601, "Unknown fixture method.");
});

function definition(name, description) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: name === "echo" ? { value: { type: "string" } } : {},
      required: name === "echo" ? ["value"] : [],
      additionalProperties: false,
    },
  };
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
  );
}
