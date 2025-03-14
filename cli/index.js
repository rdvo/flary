#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import figlet from 'figlet';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json
const packageJsonPath = resolve(__dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const version = packageJson.version;

const program = new Command();

console.log(
  chalk.blue(
    figlet.textSync('Flary CLI', { horizontalLayout: 'full' })
  )
);

program
  .version(version)
  .description('Flary CLI - Tools for Cloudflare Workers')
  .option('-d, --debug', 'output extra debugging')
  .action(() => {
    console.log('Welcome to Flary CLI!');
    console.log('Run with --help to see available commands');
  });

// Add commands here

program.parse(process.argv); 