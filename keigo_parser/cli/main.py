#!/usr/bin/env python3
"""
Keigo Parser CLI - Main Entry Point

A command-line interface for parsing RocksDB trace logs into JSON format
for visualization with the Keigo visualizer.

Usage:
    keigo-parser <command> [options]

Commands:
    parse       Parse RocksDB trace logs into JSON
    configs     List/show available configuration files
    quick       Quick workflow: auto-detect and parse

Examples:
    # Parse a trace log
    keigo-parser parse 50M_hybrid/visual_profile.log -n 50M_hybrid \\
        -p 50M_hybrid/run_config_loading.txt 50M_hybrid/loading.log \\
        -p 50M_hybrid/run_config_execution.txt 50M_hybrid/execution.log
    
    # List available configs
    keigo-parser configs
    
    # Quick parse from a directory
    keigo-parser quick ~/runs/50M_hybrid/
"""

import click
from trogon import tui

from .parse import parse
from .configs import configs
from .quick import quick

CONTEXT_SETTINGS = dict(help_option_names=['-h', '--help'])


def print_version(ctx, param, value):
    """Print version and exit."""
    if value:
        from . import __version__
        click.echo(f'keigo-parser, version {__version__}')
        ctx.exit()


@tui()
@click.group(context_settings=CONTEXT_SETTINGS)
@click.option('-V', '--version', is_flag=True, type=click.BOOL, callback=print_version,
              expose_value=False, is_eager=True, help='Show the version and exit.')
def cli():
    """Keigo Parser CLI - Parse RocksDB trace logs for visualization.
    
    This tool parses RocksDB visual profiler trace logs into JSON format
    that can be visualized with the Keigo visualizer.
    
    \b
    Commands:
      parse    Parse RocksDB trace logs into JSON format
      configs  List/show available configuration files
      quick    Auto-detect logs and parse in one step
    
    \b
    Quick Start:
      1. Parse a trace:     keigo-parser parse trace.log -n mytrace
      2. List configs:      keigo-parser configs
      3. Use with config:   keigo-parser parse trace.log -c rocksdb
    
    \b
    Or use the TUI:
      keigo-parser tui
    """
    pass


# Add commands to the main CLI group
cli.add_command(parse)
cli.add_command(configs)
cli.add_command(quick)


if __name__ == '__main__':
    cli()
