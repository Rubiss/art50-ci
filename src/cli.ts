#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "commander";
import {
  art50ConfigSchema,
  loadConfig,
  resolveConfigPath,
  type Art50Config,
  type LoadedConfig,
  type SurfaceConfig,
  writeStarterConfig,
} from "./config.js";
import { runAudit } from "./audit.js";
import { writeReports } from "./report.js";
import { redactUrlsInText } from "./redact.js";
import { resolveTarget } from "./target.js";
import { TOOL_NAME, TOOL_VERSION } from "./version.js";

interface CommonAuditOptions {
  config?: string;
  output?: string;
  headed?: boolean;
  allowPrivateOrigin?: string[];
}

interface VerifyOptions extends CommonAuditOptions {
  surface?: string;
  selector?: string;
  text?: string;
  match: "contains" | "exact" | "regex";
  caseSensitive?: boolean;
  hidden?: boolean;
  c2pa?: boolean;
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function outputDirectoryFor(
  config: Art50Config,
  baseDirectory: string,
  requestedOutput: string | undefined,
): string {
  return path.resolve(
    requestedOutput ? process.cwd() : baseDirectory,
    requestedOutput ?? config.output.directory,
  );
}

function selectSurface(
  loaded: LoadedConfig,
  target: string,
  surfaceId: string | undefined,
): SurfaceConfig {
  if (loaded.config.surfaces.length === 0) {
    throw new Error(
      "The configuration contains no browser surfaces. Add a surface or use --c2pa for a one-off asset inspection.",
    );
  }
  if (surfaceId) {
    const selected = loaded.config.surfaces.find(
      (surface) => surface.id === surfaceId,
    );
    if (!selected) {
      throw new Error(
        `Surface "${surfaceId}" was not found. Available surfaces: ${loaded.config.surfaces
          .map((surface) => surface.id)
          .join(", ")}`,
      );
    }
    return selected;
  }

  const requestedTarget = resolveTarget(target, process.cwd());
  const targetMatch = loaded.config.surfaces.find(
    (surface) =>
      resolveTarget(surface.target, loaded.baseDirectory) === requestedTarget,
  );
  if (targetMatch) {
    return targetMatch;
  }

  if (loaded.config.surfaces.length === 1) {
    return loaded.config.surfaces[0]!;
  }

  throw new Error(
    "The config has multiple surfaces. Pass --surface <id> to choose which expectations to use.",
  );
}

function makeStandaloneConfig(
  target: string,
  options: VerifyOptions,
): Art50Config {
  if (!options.selector || !options.text) {
    throw new Error(
      'Without a config, verify requires both --selector and --text. Run "art50-ci init" to create a reusable config.',
    );
  }

  return art50ConfigSchema.parse({
    version: 1,
    project: { name: "standalone-verification" },
    surfaces: [
      {
        id: "standalone",
        target,
        disclosures: [
          {
            id: "cli-expectation",
            selector: options.selector,
            expectedText: options.text,
            match: options.match,
            caseSensitive: options.caseSensitive ?? false,
            visible: !(options.hidden ?? false),
          },
        ],
      },
    ],
  });
}

function overrideDisclosure(
  surface: SurfaceConfig,
  options: VerifyOptions,
): SurfaceConfig {
  if (!options.selector && !options.text) {
    return surface;
  }
  if (!options.selector || !options.text) {
    throw new Error("--selector and --text must be supplied together.");
  }

  return {
    ...surface,
    disclosures: [
      {
        id: "cli-expectation",
        selector: options.selector,
        expectedText: options.text,
        match: options.match,
        caseSensitive: options.caseSensitive ?? false,
        visible: !(options.hidden ?? false),
        inViewport: true,
        unobstructed: true,
        accessible: true,
      },
    ],
  };
}

function printResult(
  passed: boolean,
  failures: number,
  jsonPath: string,
  htmlPath: string,
): void {
  console.log(
    `CHECKS ${passed ? "PASS" : "FAIL"} — configured technical assertions only; not a legal compliance conclusion`,
  );
  console.log(`${failures} failure${failures === 1 ? "" : "s"}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`HTML: ${htmlPath}`);
}

const program = new Command();
program
  .name(TOOL_NAME)
  .description(
    "Regression checks for declared AI disclosures and C2PA provenance.",
  )
  .version(TOOL_VERSION);

program
  .command("init")
  .description("Create a starter .art50-ci.yml configuration.")
  .argument("[directory]", "directory in which to create the config", ".")
  .option("-f, --force", "replace an existing configuration", false)
  .action(async (directory: string, options: { force: boolean }) => {
    const destinationDirectory = path.resolve(process.cwd(), directory);
    const destination = path.join(destinationDirectory, ".art50-ci.yml");
    await mkdir(destinationDirectory, { recursive: true });
    await writeStarterConfig(destination, options.force);
    console.log(`Created ${destination}`);
  });

program
  .command("audit")
  .description(
    "Audit every browser surface and provenance asset in the configuration.",
  )
  .option("-c, --config <path>", "configuration path")
  .option("-o, --output <directory>", "report output directory")
  .option(
    "--allow-private-origin <origin>",
    "grant one exact private origin requested by the config (repeatable)",
    collectValues,
    [],
  )
  .option("--headed", "show the browser while checks run", false)
  .action(async (options: CommonAuditOptions) => {
    const configPath = await resolveConfigPath(options.config);
    const loaded = await loadConfig(configPath);
    const outputDirectory = outputDirectoryFor(
      loaded.config,
      loaded.baseDirectory,
      options.output,
    );
    const report = await runAudit(loaded.config, {
      baseDirectory: loaded.baseDirectory,
      outputDirectory,
      configPath: loaded.path,
      mode: "audit",
      headed: options.headed ?? false,
      trustedPrivateOrigins: options.allowPrivateOrigin ?? [],
    });
    const reports = await writeReports(report, outputDirectory);
    printResult(
      report.passed,
      report.summary.totalFailures,
      reports.jsonPath,
      reports.htmlPath,
    );
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program
  .command("verify")
  .description(
    "Verify one page or inspect one asset using a configured or CLI expectation.",
  )
  .argument("<file-or-url>", "local file, file URL, or HTTP(S) URL")
  .option("-c, --config <path>", "configuration path")
  .option("--surface <id>", "configured surface whose expectations should be used")
  .option("--selector <selector>", "standalone disclosure selector")
  .option("--text <text>", "standalone expected disclosure text")
  .addOption(
    new Option("--match <mode>", "text matching mode")
      .choices(["contains", "exact", "regex"])
      .default("contains"),
  )
  .option("--case-sensitive", "use case-sensitive text matching", false)
  .option("--hidden", "expect the selected disclosure to be hidden", false)
  .option(
    "--c2pa",
    "inspect the target bytes for a required embedded C2PA manifest",
    false,
  )
  .option("-o, --output <directory>", "report output directory")
  .option(
    "--allow-private-origin <origin>",
    "grant one exact private origin requested by the target or config (repeatable)",
    collectValues,
    [],
  )
  .option("--headed", "show the browser while checks run", false)
  .action(async (target: string, options: VerifyOptions) => {
    let loaded: LoadedConfig | null = null;
    let configPath: string | null = null;
    if (!options.c2pa) {
      try {
        configPath = await resolveConfigPath(options.config);
      } catch (error) {
        if (options.config) {
          throw error;
        }
      }
    }
    if (configPath) {
      loaded = await loadConfig(configPath);
    }

    const baseDirectory = loaded?.baseDirectory ?? process.cwd();
    let config: Art50Config;
    if (options.c2pa) {
      if (
        options.selector ||
        options.text ||
        options.surface ||
        options.config
      ) {
        throw new Error(
          "--c2pa cannot be combined with --config, --selector, --text, or --surface.",
        );
      }
      config = art50ConfigSchema.parse({
        version: 1,
        project: { name: "standalone-provenance-verification" },
        provenance: [
          {
            id: "standalone-asset",
            delivered: target,
            requireManifest: true,
            requireEmbedded: true,
          },
        ],
      });
    } else if (loaded) {
      const selected = selectSurface(loaded, target, options.surface);
      const surface = overrideDisclosure(
        {
          ...selected,
          target: resolveTarget(target, process.cwd()),
        },
        options,
      );
      config = {
        ...loaded.config,
        surfaces: [surface],
        provenance: [],
      };
    } else {
      config = makeStandaloneConfig(target, options);
    }

    const outputDirectory = outputDirectoryFor(
      config,
      baseDirectory,
      options.output,
    );
    const report = await runAudit(config, {
      baseDirectory,
      outputDirectory,
      ...(loaded ? { configPath: loaded.path } : {}),
      mode: "verify",
      headed: options.headed ?? false,
      trustedPrivateOrigins: options.allowPrivateOrigin ?? [],
    });
    const reports = await writeReports(report, outputDirectory);
    printResult(
      report.passed,
      report.summary.totalFailures,
      reports.jsonPath,
      reports.htmlPath,
    );
    if (!report.passed) {
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((error: unknown) => {
  console.error(
    `${TOOL_NAME}: ${redactUrlsInText(
      error instanceof Error ? error.message : String(error),
    )}`,
  );
  process.exitCode = 2;
});
