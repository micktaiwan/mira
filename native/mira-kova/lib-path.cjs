/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- plain CommonJS, also run by gyp */
// Where libkova.a (Kova's terminal as a Rust staticlib) is looked for, in order:
//   1. $KOVA_LIB, an explicit path to the .a
//   2. $CARGO_TARGET_DIR/release/libkova.a
//   3. ~/.cargo/target/release/libkova.a
// Shared by binding.gyp (`node lib-path.cjs` prints the path) and build.mjs, so
// the two can never disagree on which file gets linked.
const os = require('os')
const path = require('path')

function kovaLibPath(env = process.env) {
  if (env.KOVA_LIB) return path.resolve(env.KOVA_LIB)
  const targetDir = env.CARGO_TARGET_DIR || path.join(os.homedir(), '.cargo', 'target')
  return path.join(path.resolve(targetDir), 'release', 'libkova.a')
}

module.exports = { kovaLibPath }

if (require.main === module) process.stdout.write(kovaLibPath())
