import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { canonicalOrigin } from "./network-policy.js";

const identifierSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
    "must begin with a letter or number and contain only letters, numbers, dashes, and underscores",
  );

const privateOriginSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, context) => {
    try {
      return canonicalOrigin(value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  });

const networkSchema = z
  .object({
    maxRedirects: z.number().int().min(0).max(10).default(5),
    requestedPrivateOrigins: z.array(privateOriginSchema).default([]),
  })
  .strict()
  .default({
    maxRedirects: 5,
    requestedPrivateOrigins: [],
  })
  .superRefine((value, context) => {
    reportDuplicates(value.requestedPrivateOrigins, (origin) => {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestedPrivateOrigins"],
        message: `duplicate private origin "${origin}"`,
      });
    });
  });

export const disclosureSchema = z
  .object({
    id: identifierSchema,
    description: z.string().min(1).optional(),
    selector: z.string().trim().min(1),
    expectedText: z.string().trim().min(1),
    match: z.enum(["contains", "exact", "regex"]).default("contains"),
    caseSensitive: z.boolean().default(false),
    visible: z.boolean().default(true),
    inViewport: z.boolean().default(true),
    unobstructed: z.boolean().default(true),
    accessible: z.boolean().default(true),
    accessibleName: z.string().trim().min(1).optional(),
    contentSelector: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.match !== "regex") {
      return;
    }

    try {
      new RegExp(value.expectedText, value.caseSensitive ? "" : "i");
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedText"],
        message: `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

export const surfaceSchema = z
  .object({
    id: identifierSchema,
    name: z.string().min(1).optional(),
    kind: z
      .enum(["website", "application", "chatbot", "generated-content", "other"])
      .default("website"),
    target: z.string().trim().min(1),
    waitFor: z.string().trim().min(1).optional(),
    viewport: z
      .object({
        width: z.number().int().positive().max(7680),
        height: z.number().int().positive().max(4320),
      })
      .strict()
      .optional(),
    firstInteraction: z
      .object({
        selector: z.string().trim().min(1),
        action: z.enum(["focus", "click"]).default("focus"),
      })
      .strict()
      .optional(),
    disclosures: z.array(disclosureSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    reportDuplicates(
      value.disclosures.map((disclosure) => disclosure.id),
      (id) => {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["disclosures"],
          message: `duplicate disclosure id "${id}"`,
        });
      },
    );
  });

export const provenanceSchema = z
  .object({
    id: identifierSchema,
    name: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    source: z.string().trim().min(1).optional(),
    delivered: z.string().trim().min(1).optional(),
    requireManifest: z.boolean().default(true),
    requireEmbedded: z.boolean().default(true),
    requireSourceManifestInDeliveredChain: z.boolean().default(true),
    failOnInvalid: z.boolean().default(true),
    expectedDigitalSourceType: z
      .string()
      .trim()
      .url("must be a complete digital source type URI")
      .optional(),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024)
      .default(50 * 1024 * 1024),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.source && !value.delivered) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source"],
        message: "at least one of source or delivered must be configured",
      });
    }
  });

export const art50ConfigSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    project: z
      .object({
        name: z.string().min(1),
      })
      .strict(),
    browser: z
      .object({
        timeoutMs: z.number().int().positive().max(120_000).default(15_000),
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle"])
          .default("domcontentloaded"),
        viewport: z
          .object({
            width: z.number().int().positive().max(7680).default(1440),
            height: z.number().int().positive().max(4320).default(1000),
          })
          .strict()
          .default({ width: 1440, height: 1000 }),
      })
      .strict()
      .default({
        timeoutMs: 15_000,
        waitUntil: "domcontentloaded",
        viewport: { width: 1440, height: 1000 },
      }),
    network: networkSchema,
    output: z
      .object({
        directory: z.string().trim().min(1).default(".art50-ci/reports"),
        screenshots: z.boolean().default(true),
        redactSelectors: z.array(z.string().trim().min(1)).default([]),
      })
      .strict()
      .default({
        directory: ".art50-ci/reports",
        screenshots: true,
        redactSelectors: [],
      }),
    surfaces: z.array(surfaceSchema).default([]),
    provenance: z.array(provenanceSchema).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.surfaces.length === 0 && value.provenance.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["surfaces"],
        message: "configure at least one surface or provenance asset",
      });
    }
    reportDuplicates(
      value.surfaces.map((surface) => surface.id),
      (id) => {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["surfaces"],
          message: `duplicate surface id "${id}"`,
        });
      },
    );
    reportDuplicates(
      value.provenance.map((item) => item.id),
      (id) => {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["provenance"],
          message: `duplicate provenance id "${id}"`,
        });
      },
    );
  });

export type DisclosureConfig = z.infer<typeof disclosureSchema>;
export type SurfaceConfig = z.infer<typeof surfaceSchema>;
export type ProvenanceConfig = z.infer<typeof provenanceSchema>;
export type Art50Config = z.infer<typeof art50ConfigSchema>;

export interface LoadedConfig {
  config: Art50Config;
  path: string;
  baseDirectory: string;
}

function reportDuplicates(values: string[], report: (value: string) => void): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }

  for (const duplicate of duplicates) {
    report(duplicate);
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "config";
      return `${location}: ${issue.message}`;
    })
    .join("\n");
}

export function parseConfigText(contents: string): Art50Config {
  let value: unknown;

  try {
    value = parseYaml(contents);
  } catch (error) {
    throw new Error(
      `Could not parse YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = art50ConfigSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid art50-ci configuration:\n${formatZodError(result.error)}`);
  }

  return result.data;
}

export async function resolveConfigPath(
  requestedPath: string | undefined,
  cwd = process.cwd(),
): Promise<string> {
  if (requestedPath) {
    const resolved = path.resolve(cwd, requestedPath);
    await access(resolved);
    return resolved;
  }

  for (const candidate of [".art50-ci.yml", ".art50-ci.yaml"]) {
    const resolved = path.resolve(cwd, candidate);
    try {
      await access(resolved);
      return resolved;
    } catch {
      // Try the next conventional filename.
    }
  }

  throw new Error(
    `No configuration found in ${cwd}. Run "art50-ci init" or pass --config.`,
  );
}

export async function loadConfig(configPath: string): Promise<LoadedConfig> {
  const resolvedPath = path.resolve(configPath);
  const contents = await readFile(resolvedPath, "utf8");

  return {
    config: parseConfigText(contents),
    path: resolvedPath,
    baseDirectory: path.dirname(resolvedPath),
  };
}

export const starterConfig = `# yaml-language-server: $schema=https://raw.githubusercontent.com/Rubiss/art50-ci/main/schema/art50-ci.schema.json
version: 1
project:
  name: my-ai-product

browser:
  timeoutMs: 15000
  waitUntil: domcontentloaded
  viewport:
    width: 1440
    height: 1000

network:
  maxRedirects: 5
  # Add private redirect/subresource origins here. Each private origin must
  # also be explicitly granted with --allow-private-origin at runtime.
  requestedPrivateOrigins: []

output:
  directory: .art50-ci/reports
  screenshots: true
  redactSelectors:
    - "input[type=password]"
    - "[data-sensitive]"

surfaces:
  - id: public-ai-assistant
    name: Public AI assistant
    kind: chatbot
    target: https://example.com/assistant
    firstInteraction:
      selector: "[data-assistant-input]"
      action: focus
    disclosures:
      - id: ai-interaction-notice
        description: The user is told that they are interacting with an AI system.
        selector: "[data-ai-disclosure]"
        expectedText: "You are interacting with an AI system"
        match: contains
        caseSensitive: false
        visible: true
        inViewport: true
        unobstructed: true
        accessible: true

# Optional source-to-delivery C2PA regression check:
# provenance:
#   - id: generated-poster
#     source: ./assets/poster.png
#     delivered: https://cdn.example.com/poster.png
#     requireManifest: true
#     requireEmbedded: true
#     requireSourceManifestInDeliveredChain: true
`;

export async function writeStarterConfig(
  destination: string,
  force: boolean,
): Promise<void> {
  if (!force) {
    try {
      await access(destination);
      throw new Error(
        `Configuration already exists at ${destination}. Use --force to replace it.`,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Configuration already exists")
      ) {
        throw error;
      }
    }
  }

  await writeFile(destination, starterConfig, "utf8");
}
