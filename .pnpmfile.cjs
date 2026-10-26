// better-auth lists vitest as an optional peer (for its test helpers). pnpm resolves it to the workspace's vitest,
// and `pnpm deploy --prod` then ships vitest's dependencies (rolldown, esbuild, lightningcss, chai…) in the
// registry's Docker image. The registry never loads them.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === "better-auth") {
        delete pkg.peerDependencies?.vitest;
        delete pkg.peerDependenciesMeta?.vitest;
      }
      return pkg;
    },
  },
};
