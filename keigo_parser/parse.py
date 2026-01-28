"""
Parse command for Keigo Parser CLI.

Wraps the keigo-log-parser Node.js script for parsing RocksDB trace logs.
"""

import sys
from pathlib import Path
from typing import Optional, Tuple

import click

from .lib.common import log_info, log_error, log_success, resolve_output_path
from .lib.parser import run_parser


class PhaseType(click.ParamType):
    """Custom parameter type for phase arguments (config, perf_log pairs)."""
    name = "phase"
    
    def convert(self, value, param, ctx):
        if isinstance(value, tuple):
            return value
        return value


@click.command('parse')
@click.argument('input_file', type=click.Path(exists=True, path_type=Path))
@click.argument('output_file', type=click.Path(path_type=Path), required=False, default=None)
@click.option('-c', '--config', 'config_file', type=str,
              help='YAML/JSON config file or catalog name (e.g., "rocksdb", "wiredtiger")')
@click.option('-p', '--phase', 'phases', nargs=2, type=click.Path(exists=True, path_type=Path),
              multiple=True, metavar='CONFIG PERF_LOG',
              help='Phase data: config file and performance log (can be repeated)')
@click.option('-n', '--name', 'trace_name', type=str, default=None,
              help='Trace name (used for output filename if output not specified)')
@click.option('-o', '--output-dir', type=click.Path(path_type=Path), default=None,
              help='Output directory (default: current directory)')
@click.option('--stdout', is_flag=True, default=False,
              help='Output to stdout instead of file')
def parse(
    input_file: Path,
    output_file: Optional[Path],
    config_file: Optional[str],
    phases: Tuple[Tuple[Path, Path], ...],
    trace_name: Optional[str],
    output_dir: Optional[Path],
    stdout: bool,
) -> None:
    """Parse RocksDB trace log into JSON for visualization.
    
    \b
    Arguments:
      INPUT_FILE   Path to the visual_profile.log file
      OUTPUT_FILE  Optional path for output JSON (auto-generated if not provided)
    
    \b
    Config File:
      Use -c/--config to specify tier patterns, labels, and phase names.
      Supports YAML (.yaml/.yml) or JSON (.json) format.
      Can also use a catalog name: rocksdb, wiredtiger, leveldb, postgres
    
    \b
    Phase Data:
      Use -p/--phase to add performance data for each phase.
      Each phase requires two files: a config file and a perf log file.
    
    \b
    Examples:
      # Simple parse (output to current directory)
      keigo-parser parse trace/visual_profile.log
      
      # Parse with config file for tier patterns
      keigo-parser parse trace/visual_profile.log -c rocksdb
      
      # Parse with custom name
      keigo-parser parse trace/visual_profile.log -n my_experiment
      
      # Parse to specific output directory
      keigo-parser parse trace/visual_profile.log -o /tmp/traces/
      
      # Parse with phase data
      keigo-parser parse 50M/visual_profile.log -n 50M \\
          -p 50M/run_config_loading.txt 50M/loading.log \\
          -p 50M/run_config_execution.txt 50M/execution.log
      
      # Parse to specific output file
      keigo-parser parse trace.log /tmp/output.json
      
      # Output to stdout (for piping)
      keigo-parser parse trace.log --stdout
    """
    # Determine output file path
    if stdout:
        final_output = None
    else:
        final_output = resolve_output_path(
            output_file=output_file,
            output_dir=output_dir,
            trace_name=trace_name,
            input_file=input_file,
        )
        
        # Ensure output directory exists
        if final_output:
            final_output.parent.mkdir(parents=True, exist_ok=True)
    
    # Run the parser
    success, output_path = run_parser(
        input_file=input_file,
        output_file=final_output,
        config_file=config_file,
        phases=list(phases) if phases else None,
        name=trace_name,
        stdout=stdout,
    )
    
    if not success:
        sys.exit(1)
