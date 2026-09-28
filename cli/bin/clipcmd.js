#!/usr/bin/env node
'use strict';
// dist/cli/index.js only auto-runs when it is the main module, so call it explicitly.
require('../dist/cli/index.js').run(process.argv.slice(2));
