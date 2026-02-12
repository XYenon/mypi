import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export const USER_AGENT = `${pkg.name}/${pkg.version} (+https://github.com/XYenon/mypi)`;
