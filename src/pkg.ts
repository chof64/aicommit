import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

/** npm package name (e.g. `@chof64/aicommit`). */
export const PACKAGE_NAME = pkg.name;
/** Semver from package.json — bumped by release-it before publish builds. */
export const PACKAGE_VERSION = pkg.version;
