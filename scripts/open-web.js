'use strict';

// Opens docs/index.html in the default browser on Windows, macOS and Linux.

const path = require('path');
const { spawn } = require('child_process');

const file = path.join(__dirname, '..', 'docs', 'index.html');
const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', file]]
  : process.platform === 'darwin' ? ['open', [file]]
    : ['xdg-open', [file]];

spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
console.log('Opened ' + file);
