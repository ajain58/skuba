import path from 'path';

import { readdir, writeFile } from 'fs-extra';
import { gte, sort } from 'semver';

import type { Logger } from '../../../utils/logging';
import { getConsumerManifest } from '../../../utils/manifest';
import { detectPackageManager } from '../../../utils/packageManager';
import { getSkubaVersion } from '../../../utils/version';
import type { SkubaPackageJson } from '../../init/writePackageJson';
import type { InternalLintResult } from '../../lint/internal';
import { formatPackage } from '../processing/package';

export type Patches = Patch[];
export type Patch = {
  apply: PatchFunction;
  description: string;
};
export type PatchReturnType =
  | { result: 'apply' }
  | { result: 'skip'; reason?: string };
export type PatchFunction = (
  mode: 'format' | 'lint',
) => Promise<PatchReturnType>;

const getPatches = async (manifestVersion: string): Promise<Patches> => {
  const patches = await readdir(path.join(__dirname, 'patches'));

  // The patches are sorted by the version they were added from.
  // Only return patches that are newer or equal to the current version.
  const patchesForVersion = sort(
    patches.filter((filename) => gte(filename, manifestVersion)),
  );

  return (await Promise.all(patchesForVersion.map(resolvePatches))).flat();
};

const fileExtensions = ['js', 'ts'];

// Hack to allow our Jest environment/transform to resolve the patches
// In normal scenarios this will resolve immediately after the .js import
const resolvePatches = async (version: string): Promise<Patches> => {
  for (const extension of fileExtensions) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
      return (await import(`./patches/${version}/index.${extension}`)).patches;
    } catch {
      // Ignore
    }
  }
  throw new Error(`Could not resolve patches for ${version}`);
};

export const upgradeSkuba = async (
  mode: 'lint' | 'format',
  logger: Logger,
): Promise<InternalLintResult> => {
  const [currentVersion, manifest] = await Promise.all([
    getSkubaVersion(),
    getConsumerManifest(),
  ]);

  if (!manifest) {
    throw new Error('Could not find a package json for this project');
  }

  manifest.packageJson.skuba ??= { version: '1.0.0' };

  const manifestVersion = (manifest.packageJson.skuba as SkubaPackageJson)
    .version;

  // We are up to date, skip patches
  if (gte(manifestVersion, currentVersion)) {
    return { ok: true, fixable: false };
  }

  const patches = await getPatches(manifestVersion);
  // No patches to apply even if version out of date. Early exit to avoid unnecessary commits.
  if (patches.length === 0) {
    return { ok: true, fixable: false };
  }

  if (mode === 'lint') {
    const results = await Promise.all(
      patches.map(async ({ apply }) => await apply(mode)),
    );

    // No patches are applicable. Early exit to avoid unnecessary commits.
    if (results.every(({ result }) => result === 'skip')) {
      return { ok: true, fixable: false };
    }

    const packageManager = await detectPackageManager();

    logger.warn(
      `skuba has patches to apply. Run ${logger.bold(
        packageManager.exec,
        'skuba',
        'format',
      )} to run them. ${logger.dim('skuba-patches')}`,
    );

    return {
      ok: false,
      fixable: true,
      annotations: [
        {
          // package.json as likely skuba version has changed
          // TODO: locate the "skuba": {} config in the package.json and annotate on the version property
          path: manifest.path,
          message: `skuba has patches to apply. Run ${packageManager.exec} skuba format to run them.`,
        },
      ],
    };
  }

  logger.plain('Updating skuba...');

  // Run these in series in case a subsequent patch relies on a previous patch
  for (const { apply, description } of patches) {
    const result = await apply(mode);
    logger.newline();
    if (result.result === 'skip') {
      logger.plain(
        `Patch skipped: ${description}${
          result.reason ? ` - ${result.reason}` : ''
        }`,
      );
    } else {
      logger.plain(`Patch applied: ${description}`);
    }
  }

  (manifest.packageJson.skuba as SkubaPackageJson).version = currentVersion;

  const updatedPackageJson = await formatPackage(manifest.packageJson);

  await writeFile(manifest.path, updatedPackageJson);
  logger.newline();
  logger.plain('skuba update complete.');
  logger.newline();

  return {
    ok: true,
    fixable: false,
  };
};
