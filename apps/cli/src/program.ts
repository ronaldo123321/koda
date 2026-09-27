import { Command, Option } from "commander";

import { KODA_VERSION } from "@koda/distribution";

import { runArtifactGarbageCollectionCommand } from "./artifact-command.js";
import type { TextWriter } from "./console-event-sink.js";
import {
  runExtensionListCommand,
  runExtensionReadCommand,
} from "./extension-command.js";
import {
  runPluginDiscoverCommand,
  runPluginInstallCommand,
  runPluginInstallRemoteCommand,
  runPluginListCommand,
  runPluginPublishCatalogCommand,
  runPluginRotateKeyCommand,
  runPluginStateCommand,
  runPluginUpdateCommand,
  runPluginVerifyCommand,
} from "./plugin-command.js";
import { runCommand, type RunCommandInput } from "./run-command.js";
import {
  runRemoteDeviceIssueCommand,
  runRemoteDeviceRevokeCommand,
  runRemoteRequestAbandonCommand,
  runRemoteRequestInspectCommand,
  runRemoteServeCommand,
  runRemoteThreadExposeCommand,
  runRemoteWorkspaceAddCommand,
  runRemoteWorkspaceListCommand,
} from "./remote-command.js";
import { runSetupCommand } from "./setup-command.js";
import {
  runThreadChildrenCommand,
  runThreadListCommand,
  runThreadShowCommand,
} from "./thread-command.js";
import {
  runWorkspaceMutationBackupExportCommand,
  runWorkspaceMutationConflictInspectCommand,
  runWorkspaceMutationConflictListCommand,
  runWorkspaceMutationConflictResolveCommand,
} from "./workspace-mutation-command.js";

export interface ProgramRuntime {
  environment: NodeJS.ProcessEnv;
  processDirectory: string;
  stdin?: NodeJS.ReadableStream;
  stdout: TextWriter;
  stderr: TextWriter;
  setExitCode(code: number): void;
}

export function createProgram(runtime: ProgramRuntime): Command {
  const program = new Command();
  // Configure this before adding subcommands so Commander copies the override
  // into each child command instead of terminating the host process directly.
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => {
      runtime.stdout.write(text);
    },
    writeErr: (text) => {
      runtime.stderr.write(text);
    },
  });
  program
    .name("koda")
    .description("A local-first coding agent")
    .version(KODA_VERSION);

  program
    .command("run")
    .description("Run one coding-agent turn")
    .argument("<prompt...>", "task for Koda")
    .option("-C, --cwd <directory>", "workspace directory")
    .option("-m, --model <model>", "model ID for the selected provider")
    .addOption(
      new Option("-p, --provider <provider>", "model provider").choices([
        "openai",
        "anthropic",
        "deepseek",
        "kimi",
        "glm",
      ]),
    )
    .option("--resume <thread-id>", "resume an existing Koda thread")
    .option(
      "--parent <thread-id>",
      "create a new thread linked to a local parent",
    )
    .addOption(
      new Option(
        "--approval-mode <mode>",
        "write and command approval behavior",
      ).choices(["on-request", "never"]),
    )
    .action(
      async (
        promptParts: string[],
        options: {
          approvalMode?: string;
          cwd?: string;
          model?: string;
          parent?: string;
          provider?: string;
          resume?: string;
        },
      ) => {
        const controller = new AbortController();
        let interrupted = false;
        const onSigint = () => {
          if (interrupted) {
            return;
          }
          interrupted = true;
          controller.abort("Interrupted by user.");
        };
        process.once("SIGINT", onSigint);
        try {
          const input: RunCommandInput = {
            prompt: promptParts.join(" "),
            signal: controller.signal,
            ...(options.approvalMode === undefined
              ? {}
              : { approvalMode: options.approvalMode }),
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.parent === undefined
              ? {}
              : { parentThreadId: options.parent }),
            ...(options.provider === undefined
              ? {}
              : { provider: options.provider }),
            ...(options.resume === undefined ? {} : { resume: options.resume }),
          };
          const exitCode = await runCommand(input, {
            environment: runtime.environment,
            processDirectory: runtime.processDirectory,
            stdout: runtime.stdout,
            stderr: runtime.stderr,
            stdin: runtime.stdin ?? process.stdin,
          });
          runtime.setExitCode(exitCode);
        } finally {
          process.removeListener("SIGINT", onSigint);
        }
      },
    );

  program
    .command("setup")
    .description("Configure a workspace provider and model")
    .option("-C, --cwd <directory>", "workspace directory")
    .option("-m, --model <model>", "model ID for the selected provider")
    .addOption(
      new Option("-p, --provider <provider>", "model provider").choices([
        "openai",
        "anthropic",
        "deepseek",
        "kimi",
        "glm",
      ]),
    )
    .option("--check", "make one minimal Provider connection check")
    .option("--json", "emit a stable machine-readable result")
    .action(
      async (options: {
        cwd?: string;
        check?: boolean;
        json?: boolean;
        model?: string;
        provider?: string;
      }) => {
        const controller = new AbortController();
        const onSigint = () => controller.abort("Interrupted by user.");
        if (options.check === true) process.once("SIGINT", onSigint);
        try {
          runtime.setExitCode(
            await runSetupCommand(options, {
              environment: runtime.environment,
              processDirectory: runtime.processDirectory,
              stdout: runtime.stdout,
              stderr: runtime.stderr,
              signal: controller.signal,
              ...(runtime.stdin === undefined ? {} : { stdin: runtime.stdin }),
            }),
          );
        } finally {
          process.removeListener("SIGINT", onSigint);
        }
      },
    );

  const thread = program
    .command("thread")
    .description("Inspect local Koda thread metadata");
  thread
    .command("list")
    .description("List local Koda threads")
    .option("--limit <count>", "maximum threads to show", "50")
    .option("--workspace <directory>", "filter by canonical workspace")
    .action(async (options: { limit?: string; workspace?: string }) => {
      runtime.setExitCode(
        await runThreadListCommand(options, {
          environment: runtime.environment,
          processDirectory: runtime.processDirectory,
          stdout: runtime.stdout,
          stderr: runtime.stderr,
        }),
      );
    });

  thread
    .command("children")
    .description("List direct child threads")
    .argument("<thread-id>", "parent thread ID")
    .option("--limit <count>", "maximum children to show", "50")
    .action(async (threadId: string, options: { limit?: string }) => {
      runtime.setExitCode(
        await runThreadChildrenCommand(threadId, options, {
          environment: runtime.environment,
          processDirectory: runtime.processDirectory,
          stdout: runtime.stdout,
          stderr: runtime.stderr,
        }),
      );
    });

  const extension = program
    .command("extension")
    .description("Inspect current Koda extensions without starting a turn");
  extension
    .command("list")
    .description("List current project Skills, templates, and plugin manifests")
    .option("--workspace <directory>", "workspace directory", ".")
    .action(async (options: { workspace?: string }) => {
      runtime.setExitCode(
        await runExtensionListCommand(options, {
          environment: runtime.environment,
          processDirectory: runtime.processDirectory,
          stdout: runtime.stdout,
          stderr: runtime.stderr,
        }),
      );
    });
  extension
    .command("read")
    .description("Read one validated current extension source")
    .argument("<kind>", "skill or command-template")
    .argument("<source-id>", "stable extension source ID")
    .option("--workspace <directory>", "workspace directory", ".")
    .action(
      async (
        kind: string,
        sourceId: string,
        options: { workspace?: string },
      ) => {
        if (kind !== "skill" && kind !== "command-template") {
          runtime.stderr.write(
            "error: extension kind must be 'skill' or 'command-template'\n",
          );
          runtime.setExitCode(2);
          return;
        }
        runtime.setExitCode(
          await runExtensionReadCommand(kind, sourceId, options, {
            environment: runtime.environment,
            processDirectory: runtime.processDirectory,
            stdout: runtime.stdout,
            stderr: runtime.stderr,
          }),
        );
      },
    );
  const plugin = program
    .command("plugin")
    .description("Verify and manage signed local plugin packages");
  const pluginContext = {
    environment: runtime.environment,
    processDirectory: runtime.processDirectory,
    stdout: runtime.stdout,
    stderr: runtime.stderr,
  };
  plugin
    .command("verify")
    .description(
      "Verify a local plugin package against an explicit publisher key",
    )
    .argument("<directory>", "plugin package directory")
    .requiredOption("--key-id <id>", "trusted publisher key ID")
    .requiredOption("--key <file>", "trusted Ed25519 public key PEM")
    .action(
      async (directory: string, options: { keyId: string; key: string }) => {
        runtime.setExitCode(
          await runPluginVerifyCommand(directory, options, {
            processDirectory: runtime.processDirectory,
            stdout: runtime.stdout,
            stderr: runtime.stderr,
          }),
        );
      },
    );
  plugin
    .command("install")
    .description("Install a verified package in the disabled state")
    .argument("<directory>", "plugin package directory")
    .requiredOption("--key-id <id>", "trusted publisher key ID")
    .requiredOption("--key <file>", "trusted Ed25519 public key PEM")
    .requiredOption(
      "--capabilities <list>",
      "explicitly reviewed plugin capabilities",
    )
    .action(
      async (
        directory: string,
        options: {
          keyId: string;
          key: string;
          capabilities: string;
        },
      ) => {
        runtime.setExitCode(
          await runPluginInstallCommand(directory, options, pluginContext),
        );
      },
    );
  plugin
    .command("discover")
    .description("List a signed HTTPS plugin catalog without executing code")
    .requiredOption("--catalog <url>", "HTTPS catalog URL")
    .requiredOption("--key-id <id>", "trusted publisher key ID")
    .requiredOption("--key <file>", "trusted Ed25519 public key PEM")
    .action(
      async (options: { catalog: string; keyId: string; key: string }) => {
        runtime.setExitCode(
          await runPluginDiscoverCommand(options, pluginContext),
        );
      },
    );
  plugin
    .command("publish-catalog")
    .description("Verify local signed packages and write catalog.json")
    .argument("<directory>", "catalog root containing ID/version packages")
    .requiredOption("--key-id <id>", "publisher key ID")
    .requiredOption("--private-key <file>", "publisher Ed25519 private PEM")
    .requiredOption(
      "--expires-at <utc>",
      "catalog expiry as exact UTC ISO time",
    )
    .action(
      async (
        directory: string,
        options: { keyId: string; privateKey: string; expiresAt: string },
      ) => {
        runtime.setExitCode(
          await runPluginPublishCatalogCommand(
            directory,
            options,
            pluginContext,
          ),
        );
      },
    );
  plugin
    .command("install-remote")
    .description(
      "Install one exact signed catalog version in the disabled state",
    )
    .argument("<id>", "plugin ID")
    .requiredOption("--version <version>", "exact plugin version")
    .requiredOption("--catalog <url>", "HTTPS catalog URL")
    .requiredOption("--key-id <id>", "trusted publisher key ID")
    .requiredOption("--key <file>", "trusted Ed25519 public key PEM")
    .requiredOption(
      "--capabilities <list>",
      "explicitly reviewed plugin capabilities",
    )
    .action(
      async (
        id: string,
        options: {
          version: string;
          catalog: string;
          keyId: string;
          key: string;
          capabilities: string;
        },
      ) => {
        runtime.setExitCode(
          await runPluginInstallRemoteCommand(id, options, pluginContext),
        );
      },
    );
  plugin
    .command("list")
    .description("List managed plugin versions and state")
    .action(async () => {
      runtime.setExitCode(await runPluginListCommand(pluginContext));
    });
  plugin
    .command("update")
    .description(
      "Install a newer stable version from the stored signed catalog",
    )
    .argument("<id>", "plugin ID")
    .action(async (id: string) => {
      runtime.setExitCode(await runPluginUpdateCommand(id, pluginContext));
    });
  plugin
    .command("rotate-key")
    .description(
      "Explicitly replace a plugin publisher key from a signed catalog",
    )
    .argument("<id>", "installed plugin ID")
    .requiredOption("--version <version>", "exact new plugin version")
    .requiredOption("--catalog <url>", "new HTTPS catalog URL")
    .requiredOption("--old-key-id <id>", "expected current key ID")
    .requiredOption("--old-key <file>", "expected current public key PEM")
    .requiredOption("--new-key-id <id>", "independently verified new key ID")
    .requiredOption(
      "--new-key <file>",
      "independently verified new public key PEM",
    )
    .requiredOption(
      "--capabilities <list>",
      "explicitly reviewed plugin capabilities",
    )
    .action(
      async (
        id: string,
        options: {
          version: string;
          catalog: string;
          oldKeyId: string;
          oldKey: string;
          newKeyId: string;
          newKey: string;
          capabilities: string;
        },
      ) => {
        runtime.setExitCode(
          await runPluginRotateKeyCommand(id, options, pluginContext),
        );
      },
    );
  for (const operation of ["enable", "disable", "rollback"] as const) {
    plugin
      .command(operation)
      .description(`${operation} a managed plugin`)
      .argument("<id>", "plugin ID")
      .action(async (id: string) => {
        runtime.setExitCode(
          await runPluginStateCommand(id, operation, pluginContext),
        );
      });
  }
  thread
    .command("show")
    .description("Show one local Koda thread")
    .argument("<thread-id>", "Koda thread ID")
    .action(async (threadId: string) => {
      runtime.setExitCode(
        await runThreadShowCommand(threadId, {
          environment: runtime.environment,
          processDirectory: runtime.processDirectory,
          stdout: runtime.stdout,
          stderr: runtime.stderr,
        }),
      );
    });

  const remote = program
    .command("remote")
    .description("Manage remote access on the owner host");
  remote
    .command("serve")
    .description("Serve authenticated restricted HTTPS on a private interface")
    .requiredOption("--host <ip>", "private, VPN, or loopback IP address")
    .option("--port <port>", "TLS port", "8443")
    .requiredOption("--cert <file>", "TLS certificate PEM")
    .requiredOption("--key <file>", "TLS private key PEM")
    .action(
      async (options: {
        host: string;
        port: string;
        cert: string;
        key: string;
      }) => {
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        try {
          runtime.setExitCode(
            await runRemoteServeCommand(
              {
                host: options.host,
                port: options.port,
                certificatePath: options.cert,
                privateKeyPath: options.key,
              },
              runtime,
              controller.signal,
            ),
          );
        } finally {
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
        }
      },
    );
  const remoteWorkspace = remote
    .command("workspace")
    .description("Manage allowed workspaces");
  remoteWorkspace
    .command("add")
    .argument("<id>", "opaque workspace ID")
    .requiredOption("--path <directory>", "absolute host directory")
    .action(async (id: string, options: { path: string }) => {
      runtime.setExitCode(
        await runRemoteWorkspaceAddCommand(id, options.path, runtime),
      );
    });
  remoteWorkspace.command("list").action(async () => {
    runtime.setExitCode(await runRemoteWorkspaceListCommand(runtime));
  });
  const remoteDevice = remote
    .command("device")
    .description("Manage paired devices");
  remoteDevice
    .command("issue")
    .argument("<label>", "local device label")
    .requiredOption("--workspace <id>", "registered workspace ID")
    .option(
      "--permissions <list>",
      "comma-separated permissions; defaults to read-only",
    )
    .action(
      async (
        label: string,
        options: { workspace: string; permissions?: string },
      ) => {
        runtime.setExitCode(
          await runRemoteDeviceIssueCommand(
            label,
            options.workspace,
            options.permissions,
            runtime,
          ),
        );
      },
    );
  remoteDevice
    .command("revoke")
    .argument("<device-id>", "device ID from pairing")
    .action(async (deviceId: string) => {
      runtime.setExitCode(
        await runRemoteDeviceRevokeCommand(deviceId, runtime),
      );
    });
  remote
    .command("thread")
    .description("Expose verified local Thread metadata to paired devices")
    .command("expose")
    .argument("<thread-id>", "existing local Thread ID")
    .requiredOption("--workspace <id>", "registered workspace ID")
    .action(async (threadId: string, options: { workspace: string }) => {
      runtime.setExitCode(
        await runRemoteThreadExposeCommand(
          threadId,
          options.workspace,
          runtime,
        ),
      );
    });
  const remoteRequest = remote
    .command("request")
    .description(
      "Inspect or abandon an uncertain remote Turn request on the owner host",
    );
  remoteRequest
    .command("inspect")
    .argument("<request-id>", "durable remote request ID")
    .action(async (requestId: string) => {
      runtime.setExitCode(
        await runRemoteRequestInspectCommand(requestId, runtime),
      );
    });
  remoteRequest
    .command("abandon")
    .argument("<request-id>", "reserved remote request ID")
    .action(async (requestId: string) => {
      runtime.setExitCode(
        await runRemoteRequestAbandonCommand(requestId, runtime),
      );
    });

  const artifact = program
    .command("artifact")
    .description("Maintain local Koda artifacts");
  artifact
    .command("gc")
    .description("Find or delete unreferenced artifact blobs")
    .option("--delete", "delete eligible unreferenced artifacts")
    .option(
      "--min-age-hours <hours>",
      "minimum age of an unreferenced artifact",
      "24",
    )
    .action(async (options: { delete?: boolean; minAgeHours?: string }) => {
      runtime.setExitCode(
        await runArtifactGarbageCollectionCommand(options, {
          environment: runtime.environment,
          stdout: runtime.stdout,
          stderr: runtime.stderr,
        }),
      );
    });

  const recovery = program
    .command("recovery")
    .description(
      "Inspect and explicitly resolve quarantined workspace changes",
    );
  recovery
    .command("list")
    .description("List quarantined workspace mutation conflicts")
    .option("--workspace <directory>", "workspace directory", ".")
    .action(async (options: { workspace?: string }) => {
      runtime.setExitCode(
        await runWorkspaceMutationConflictListCommand(options, runtime),
      );
    });
  recovery
    .command("inspect")
    .description("Inspect one workspace mutation conflict")
    .argument("<conflict-id>", "opaque workspace mutation conflict ID")
    .option("--workspace <directory>", "workspace directory", ".")
    .action(async (conflictId: string, options: { workspace?: string }) => {
      runtime.setExitCode(
        await runWorkspaceMutationConflictInspectCommand(
          conflictId,
          options,
          runtime,
        ),
      );
    });
  recovery
    .command("export")
    .description(
      "Export one verified original backup without overwriting a file",
    )
    .argument("<conflict-id>", "opaque workspace mutation conflict ID")
    .argument("<operation-index>", "operation index containing a backup")
    .requiredOption("--state-token <sha256>", "token returned by inspection")
    .requiredOption(
      "--output <file>",
      "new output file; existing files are rejected",
    )
    .option("--workspace <directory>", "workspace directory", ".")
    .action(
      async (
        conflictId: string,
        operationIndex: string,
        options: {
          workspace?: string;
          stateToken?: string;
          output?: string;
        },
      ) => {
        runtime.setExitCode(
          await runWorkspaceMutationBackupExportCommand(
            conflictId,
            operationIndex,
            options,
            runtime,
          ),
        );
      },
    );
  recovery
    .command("resolve")
    .description("Resolve one inspected conflict using its exact state token")
    .argument("<conflict-id>", "opaque workspace mutation conflict ID")
    .requiredOption("--state-token <sha256>", "token returned by inspection")
    .addOption(
      new Option("--action <action>", "explicit resolution action")
        .choices(["restore-original", "accept-current"])
        .makeOptionMandatory(),
    )
    .option("--workspace <directory>", "workspace directory", ".")
    .action(
      async (
        conflictId: string,
        options: { workspace?: string; stateToken?: string; action?: string },
      ) => {
        runtime.setExitCode(
          await runWorkspaceMutationConflictResolveCommand(
            conflictId,
            options,
            runtime,
          ),
        );
      },
    );

  return program;
}
