/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

import path from 'path';
import fs from 'fs-extra';
import {promisify} from 'util';
import {homedir} from 'os';
import {PluginManager as PM} from 'live-plugin-manager';
import decompress from 'decompress';
import decompressTargz from 'decompress-targz';
import decompressUnzip from 'decompress-unzip';
import tmp from 'tmp';

const getTmpDir = promisify(tmp.dir) as () => Promise<string>;

export const PLUGIN_DIR = path.join(homedir(), '.flipper', 'thirdparty');

function providePluginManager(): PM {
  return new PM({
    ignoredDependencies: [/^flipper$/, /^react$/, /^react-dom$/, /^@types\//],
  });
}

function providePluginManagerNoDependencies(): PM {
  return new PM({ignoredDependencies: [/.*/]});
}

async function installPluginFromTempDir(pluginDir: string) {
  const packageJSONPath = path.join(pluginDir, 'package.json');
  const packageJSON = JSON.parse(
    (await fs.readFile(packageJSONPath)).toString(),
  );
  const name = packageJSON.name;

  await fs.ensureDir(PLUGIN_DIR);
  // create empty watchman config (required by metro's file watcher)
  await fs.writeFile(path.join(PLUGIN_DIR, '.watchmanconfig'), '{}');
  const destinationDir = path.join(PLUGIN_DIR, name);
  // Clean up existing destination files.
  await fs.remove(destinationDir);
  await fs.ensureDir(destinationDir);

  const isPreBundled = await fs.pathExists(path.join(pluginDir, 'dist'));
  if (!isPreBundled) {
    const pluginManager = providePluginManager();
    // install the plugin dependencies into node_modules
    const nodeModulesDir = path.join(destinationDir, 'node_modules');
    pluginManager.options.pluginsPath = nodeModulesDir;
    await pluginManager.installFromPath(pluginDir);
    // live-plugin-manager also installs plugin itself into the target dir, it's better remove it
    await fs.remove(path.join(nodeModulesDir, name));
  }
  // copying plugin files into the destination folder
  const pluginFiles = await fs.readdir(pluginDir);
  await Promise.all(
    pluginFiles
      .filter((f) => f !== 'node_modules')
      .map((f) =>
        fs.move(path.join(pluginDir, f), path.join(destinationDir, f)),
      ),
  );
}

async function getPluginRootDir(dir: string) {
  // npm packages are tar.gz archives containing folder 'package' inside
  const packageDir = path.join(dir, 'package');
  const isNpmPackage = await fs.pathExists(packageDir);

  // vsix packages are zip archives containing folder 'extension' inside
  const extensionDir = path.join(dir, 'extension');
  const isVsix = await fs.pathExists(extensionDir);

  if (!isNpmPackage && !isVsix) {
    throw new Error(
      'Package format is invalid: directory "package" or "extensions" not found in the archive root',
    );
  }

  return isNpmPackage ? packageDir : extensionDir;
}

export async function installPluginFromNpm(name: string) {
  const tmpDir = await getTmpDir();
  try {
    await fs.ensureDir(tmpDir);
    const plugManNoDep = providePluginManagerNoDependencies();
    plugManNoDep.options.pluginsPath = tmpDir;
    await plugManNoDep.install(name);
    const pluginTempDir = path.join(tmpDir, name);
    await installPluginFromTempDir(pluginTempDir);
  } finally {
    if (await fs.pathExists(tmpDir)) {
      await fs.remove(tmpDir);
    }
  }
}

export async function installPluginFromFile(packagePath: string) {
  const tmpDir = await getTmpDir();
  try {
    const files = await decompress(packagePath, tmpDir, {
      plugins: [decompressTargz(), decompressUnzip()],
    });
    if (!files.length) {
      throw new Error('The package is not in tar.gz format or is empty');
    }
    const pluginDir = await getPluginRootDir(tmpDir);
    await installPluginFromTempDir(pluginDir);
  } finally {
    if (await fs.pathExists(tmpDir)) {
      await fs.remove(tmpDir);
    }
  }
}
