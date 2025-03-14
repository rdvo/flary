#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import figlet from 'figlet';

const program = new Command();

console.log(
  chalk.blue(
    figlet.textSync('Flary CLI', { horizontalLayout: 'full' })
  )
);

program
  .version('0.1.0')
  .description('Flary CLI - Tools for Cloudflare Workers')
  .option('-d, --debug', 'output extra debugging')
  .action(() => {
    console.log('Welcome to Flary CLI!');
    console.log('Run with --help to see available commands');
  });

// Add commands here

program.parse(process.argv); 