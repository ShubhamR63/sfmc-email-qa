#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { audit, overallResult } = require('./audit');
const { toMarkdown, toJson } = require('./report');

const HELP = `sfmc-email-qa - HTML email QA audit for Salesforce Marketing Cloud

Usage:
  sfmc-email-qa <file-or-folder...> [options]

Options:
  -f, --format <md|json>   Report format (default: md)
  -o, --out <path>         Write report to a file (single input) or folder (multiple inputs)
      --strict             Treat WARN findings (e.g. unlinked images) as failures
  -h, --help               Show this help
  -v, --version            Show version

Exit codes: 0 = all PASS, 1 = at least one FAIL, 2 = usage / IO error.
`;

function parseArgs(argv) {
  const opts = { inputs: [], format: 'md', out: null, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '-f' || a === '--format') opts.format = argv[++i];
    else if (a === '-o' || a === '--out') opts.out = argv[++i];
    else if (a.startsWith('-')) throw new Error('Unknown option: ' + a);
    else opts.inputs.push(a);
  }
  if (!['md', 'json'].includes(opts.format)) throw new Error('Format must be "md" or "json"');
  return opts;
}

function collect(input) {
  const stat = fs.statSync(input);
  if (stat.isFile()) return [input];
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(html?|ampscript)$/i.test(entry.name)) files.push(full);
    }
  })(input);
  return files.sort();
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(e.message + '\n\n' + HELP);
    return 2;
  }
  if (opts.help || (!opts.inputs.length && !opts.version)) {
    process.stdout.write(HELP);
    return opts.help ? 0 : 2;
  }
  if (opts.version) {
    process.stdout.write(require('../package.json').version + '\n');
    return 0;
  }

  let files;
  try {
    files = opts.inputs.flatMap(collect);
  } catch (e) {
    process.stderr.write('Cannot read input: ' + e.message + '\n');
    return 2;
  }
  if (!files.length) {
    process.stderr.write('No .html files found.\n');
    return 2;
  }

  const ext = opts.format === 'json' ? '.json' : '.md';
  const outIsDir = opts.out && (files.length > 1 || /[\\/]$/.test(opts.out) || (fs.existsSync(opts.out) && fs.statSync(opts.out).isDirectory()));
  let failed = 0;

  for (const file of files) {
    const report = audit(fs.readFileSync(file, 'utf8'), file.split(path.sep).join('/'));
    const text = opts.format === 'json' ? toJson(report, opts) : toMarkdown(report, opts);
    const result = overallResult(report, opts.strict);
    if (result === 'FAIL') failed++;

    if (opts.out) {
      const target = outIsDir
        ? path.join(opts.out, path.basename(file).replace(/\.[^.]+$/, '') + '-qa' + ext)
        : opts.out;
      fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
      fs.writeFileSync(target, text);
      process.stderr.write(result + '  ' + file + '  ->  ' + target + '\n');
    } else {
      process.stdout.write(text + (files.length > 1 ? '\n---\n\n' : ''));
    }
  }
  if (files.length > 1) {
    process.stderr.write((files.length - failed) + '/' + files.length + ' emails passed.\n');
  }
  return failed ? 1 : 0;
}

process.exitCode = main();
