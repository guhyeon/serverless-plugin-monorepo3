import * as fs from 'fs-extra';
import * as path from 'path';
import * as glob from 'glob';
import Serverless from 'serverless';

/** Takes a path and returns all node_modules resolution paths (but not global include paths). */
function getNodeModulePaths(p: string): string[] {
  const result: string[] = [];
  const paths = p.split(path.sep);
  while (paths.length) {
    result.push(path.join(paths.join(path.sep) || path.sep, 'node_modules'));
    paths.pop();
  }
  return result;
}

/** Creates a symlink. Ignore errors if symlink exists or package exists. */
async function link(target: string, f: string, type: LinkType) {
  await fs.ensureDir(path.dirname(f));
  await fs.symlink(target, f, type).catch((e) => {
    if (e.code === 'EEXIST' || e.code === 'EISDIR') {
      return;
    }
    throw e;
  });
}

export type LinkType = fs.SymlinkType | fs.FsSymlinkType;

/** Settings that can be specified in serverless YAML file */
export interface ServerlessMonoRepoSettings {
  path: string;
  linkType: LinkType;
}

/** Plugin implementation */
module.exports = class ServerlessMonoRepo {
  settings: ServerlessMonoRepoSettings;
  hooks: { [key: string]: () => void };
  workspacePackages:{path:string,package:{name:string}}[] = [];

  constructor(private serverless: Serverless) {
    this.hooks = {
      'package:cleanup': () => this.clean(),
      'package:initialize': () => this.initialise(),
      'before:offline:start:init': () => this.initialise(),
      'offline:start': () => this.initialise(),
      'deploy:function:initialize': async () => {
        await this.clean();
        await this.initialise();
      },
    };

    // Settings
    const custom: Partial<ServerlessMonoRepoSettings> =
      this.serverless.service.custom?.serverlessMonoRepo ?? {};
    this.settings = {
      path: custom.path ?? this.serverless.config.servicePath,
      linkType: custom.linkType ?? 'junction',
    };
  }

  log(msg: string) {
    this.serverless.cli.log(msg);
  }

  findPnpmWorkspaceYml(currentPath:string):string|null {
    const pnpmWorkspaceYmlPath = path.join(currentPath, 'pnpm-workspace.yaml');

    if (fs.existsSync(pnpmWorkspaceYmlPath)) {
      return pnpmWorkspaceYmlPath;
    }

    const parentPath = path.dirname(currentPath);

    // Reached the root directory
    if (parentPath === currentPath) {
      return null;
    }

    return this.findPnpmWorkspaceYml(parentPath);
  }


  parseWorkspaceYml(workspaceYmlPath:string) {
    const workspaceYmlContent = fs.readFileSync(workspaceYmlPath, 'utf8');
    const lines = workspaceYmlContent.split('\n');
    const packages:string[] = [];

    lines.forEach(line => {
      const match = line.match(/^\s*-\s*'([^']+)'/);
      if (match) {
        const packageGlob = match[1];
        packages.push(packageGlob);
      }
    });

    return packages;
  }

  readPackageJsonsFromWorkspace(workspaceYmlPath:string) {
    const workspaceYmlDir = path.dirname(workspaceYmlPath);
    const packageJsons:{path:string,package:{name:string}}[] = [];

    const packages = this.parseWorkspaceYml(workspaceYmlPath);

    packages.forEach(packageGlob => {
      const packagePaths = glob.sync(packageGlob, { cwd: workspaceYmlDir });

      packagePaths.forEach((packagePath: string) => {
        const packageJsonPath = path.join(workspaceYmlDir, packagePath, 'package.json');

        if (fs.existsSync(packageJsonPath)) {
          const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
          const packageJson = JSON.parse(packageJsonContent);
          packageJsons.push({path:packageJsonPath, package: packageJson});
        }
      });
    });

    return packageJsons;
  }

  async linkPackage(
    name: string,
    fromPath: string,
    toPath: string,
    created: Set<string>,
    resolved: string[]
  ) {
    // Ignore circular dependencies
    if (resolved.includes(name)) {
      return;
    }

    // Obtain list of module resolution paths to use for resolving modules
    const paths = getNodeModulePaths(fromPath);

    // Get package file path
    let pkg: string|undefined = undefined;

    // Get workspacePackage
    const pkgIdx = this.workspacePackages.findIndex(p=>p.package.name===name)
    if(pkgIdx>-1){
      pkg = this.workspacePackages[pkgIdx].path;
    }

    if(pkg === undefined) {
      pkg = require.resolve('./' + path.join(name, 'package.json'), {
        paths,
      });
    }

    // Get relative path to package & create link if not an embedded node_modules
    const target = path.relative(
      path.join(toPath, path.dirname(name)),
      path.dirname(pkg)
    );
    if ((pkg.match(/node_modules/g) || []).length <= 1 && !created.has(name)) {
      created.add(name);
      await link(target, path.join(toPath, name), this.settings.linkType);
    }

    // Get dependencies
    const { dependencies = {} } = require(pkg);

    // Link all dependencies
    await Promise.all(
      Object.keys(dependencies).map((dep) =>
        this.linkPackage(
          dep,
          path.dirname(pkg!),
          toPath,
          created,
          resolved.concat([name])
        )
      )
    );
  }

  async clean() {
    // Remove all symlinks that are of form [...]/node_modules/link
    this.log('Cleaning dependency symlinks');

    type File = { f: string; s: fs.Stats };

    // Checks if a given stat result indicates a scoped package directory
    const isScopedPkgDir = (c: File) =>
      c.s.isDirectory() && c.f.startsWith('@');

    // Cleans all links in a specific path
    async function clean(p: string) {
      if (!(await fs.pathExists(p))) {
        return;
      }

      const files = await fs.readdir(p);
      let contents: File[] = await Promise.all(
        files.map((f) => fs.lstat(path.join(p, f)).then((s) => ({ f, s })))
      );

      // Remove all links
      await Promise.all(
        contents
          .filter((c) => c.s.isSymbolicLink())
          .map((c) => fs.unlink(path.join(p, c.f)))
      );
      contents = contents.filter((c) => !c.s.isSymbolicLink());

      // Remove all links in scoped packages
      await Promise.all(
        contents.filter(isScopedPkgDir).map((c) => clean(path.join(p, c.f)))
      );
      contents = contents.filter((c) => !isScopedPkgDir(c));

      // Remove directory if empty
      const filesInDir = await fs.readdir(p);
      if (!filesInDir.length) {
        await fs.rmdir(p);
      }
    }

    // Clean node_modules
    await clean(path.join(this.settings.path, 'node_modules'));
  }

  loadWorkspacePackages(){
    // bellow check should be outside of loop.
    // check parent project -> this package is for monorepo then it is always true
    // if exist then read packages from pnpm-workpace.yml
    const pnpmWorkspace = this.findPnpmWorkspaceYml(this.settings.path);
    // read package.json from above above packges.
    if(pnpmWorkspace){
      // get name
      // if name equals name in package.json
      // pkg = above package.json
      this.workspacePackages= this.readPackageJsonsFromWorkspace(pnpmWorkspace);
    }
  }

  async initialise() {
    // Read package JSON
    const { dependencies = {} } = require(path.join(
      this.settings.path,
      'package.json'
    ));
    this.loadWorkspacePackages();

    // Link all dependent packages
    this.log('Creating dependency symlinks');
    const contents = new Set<string>();
    await Promise.all(
      Object.keys(dependencies).map((name) =>
        this.linkPackage(
          name,
          this.settings.path,
          path.join(this.settings.path, 'node_modules'),
          contents,
          []
        )
      )
    );
  }
};
