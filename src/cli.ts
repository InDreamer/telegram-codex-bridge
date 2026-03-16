#!/usr/bin/env node

import { getBridgePaths } from "./paths.js";
import { createLogger } from "./logger.js";
import { parseProjectScanRootsValue } from "./config.js";
import {
  clearAuthorization,
  getStatus,
  installBridge,
  installCodexSkill,
  listPendingAuthorizations,
  restartService,
  runDoctor,
  startService,
  stopService,
  uninstallBridge,
  updateBridge
} from "./install.js";
import { runBridgeService } from "./service.js";

interface ParsedFlags {
  [key: string]: string | boolean | undefined;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return flags;
}

function parseBooleanFlag(value: string | boolean | undefined): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

function printUsage(): void {
  process.stdout.write(`Usage:
  ctb install --telegram-token <token> [--codex-bin <bin>] [--project-scan-roots <path1:path2:...>] [--voice-input <true|false>] [--voice-openai-api-key <key>] [--voice-openai-model <model>] [--voice-ffmpeg-bin <bin>]
  ctb install-skill
  ctb status
  ctb doctor
  ctb start | stop | restart | update
  ctb uninstall [--purge-state]
  ctb authorize pending [--latest | --select <index> | --user-id <id> | --show-expired]
  ctb authorize clear
  ctb service run
`);
}

async function main(): Promise<void> {
  const paths = getBridgePaths(import.meta.url);
  const logger = createLogger("cli", paths.bootstrapLogPath);

  const [, , command, ...argv] = process.argv;
  const subcommand = argv[0];
  const flagArgs = subcommand?.startsWith("--") ? argv : argv.slice(1);
  const flags = parseFlags(flagArgs);

  switch (command) {
    case "install": {
      const installOverrides: {
        telegramBotToken?: string;
        codexBin?: string;
        projectScanRoots?: string[];
        voiceInputEnabled?: boolean;
        voiceOpenaiApiKey?: string;
        voiceOpenaiTranscribeModel?: string;
        voiceFfmpegBin?: string;
      } = {};

      if (typeof flags["telegram-token"] === "string") {
        installOverrides.telegramBotToken = flags["telegram-token"];
      }

      if (typeof flags["codex-bin"] === "string") {
        installOverrides.codexBin = flags["codex-bin"];
      }

      if (typeof flags["project-scan-roots"] === "string") {
        installOverrides.projectScanRoots = parseProjectScanRootsValue(
          flags["project-scan-roots"],
          paths.homeDir
        );
      }

      const voiceInputEnabled = parseBooleanFlag(flags["voice-input"]);
      if (voiceInputEnabled !== undefined) {
        installOverrides.voiceInputEnabled = voiceInputEnabled;
      }
      if (typeof flags["voice-openai-api-key"] === "string") {
        installOverrides.voiceOpenaiApiKey = flags["voice-openai-api-key"];
      }
      if (typeof flags["voice-openai-model"] === "string") {
        installOverrides.voiceOpenaiTranscribeModel = flags["voice-openai-model"];
      }
      if (typeof flags["voice-ffmpeg-bin"] === "string") {
        installOverrides.voiceFfmpegBin = flags["voice-ffmpeg-bin"];
      }

      await installBridge(paths, logger, {
        ...installOverrides
      });
      process.stdout.write("install complete\n");
      process.stdout.write(`${await getStatus(paths)}\n`);
      return;
    }

    case "status": {
      process.stdout.write(`${await getStatus(paths)}\n`);
      return;
    }

    case "install-skill": {
      process.stdout.write(`${await installCodexSkill(paths)}\n`);
      return;
    }

    case "doctor": {
      process.stdout.write(`${await runDoctor(paths, logger)}\n`);
      return;
    }

    case "start": {
      await startService(paths);
      process.stdout.write("service started\n");
      return;
    }

    case "stop": {
      await stopService(paths);
      process.stdout.write("service stopped\n");
      return;
    }

    case "restart": {
      await restartService(paths);
      process.stdout.write("service restarted\n");
      return;
    }

    case "update": {
      await updateBridge(paths);
      process.stdout.write("update complete\n");
      return;
    }

    case "uninstall": {
      await uninstallBridge(paths, Boolean(flags["purge-state"]));
      process.stdout.write("uninstall complete\n");
      return;
    }

    case "authorize": {
      if (subcommand === "pending") {
        const options: {
          includeExpired?: boolean;
          latest?: boolean;
          select?: number;
          userId?: string;
        } = {};

        if (flags["show-expired"] === true) {
          options.includeExpired = true;
        }

        if (flags.latest === true) {
          options.latest = true;
        }

        if (typeof flags.select === "string") {
          options.select = Number.parseInt(flags.select, 10);
        }

        if (typeof flags["user-id"] === "string") {
          options.userId = flags["user-id"];
        }

        process.stdout.write(
          `${await listPendingAuthorizations(paths, logger, options)}\n`
        );
        return;
      }

      if (subcommand === "clear") {
        process.stdout.write(`${await clearAuthorization(paths, logger)}\n`);
        return;
      }

      printUsage();
      process.exitCode = 1;
      return;
    }

    case "service": {
      if (subcommand !== "run") {
        printUsage();
        process.exitCode = 1;
        return;
      }

      await runBridgeService(import.meta.url);
      return;
    }

    default: {
      printUsage();
      process.exitCode = 1;
    }
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
