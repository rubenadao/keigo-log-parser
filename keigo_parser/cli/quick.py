"""Quick command - auto-detect and parse in one step."""

import os
import re
import click
from pathlib import Path

from .lib.common import log_info, log_success, log_warn, log_error, resolve_output_path
from .lib.parser import run_parser


# Phase name patterns - used to detect loading/execution phases
PHASE_NAMES = ['loading', 'execution', 'load', 'exec', 'phase1', 'phase2', 'phase_1', 'phase_2']


def find_phase_pairs(directory: Path) -> list[tuple[Path, Path]]:
    """Find config/perf file pairs in the directory.
    
    Supports naming conventions:
    - run_config_loading.txt / loading.log
    - run_config_execution.txt / execution.log  
    - config1.txt / perf1.txt
    - config.txt / perf.txt
    """
    pairs = []
    files = list(directory.iterdir())
    file_names = {f.name.lower(): f for f in files if f.is_file()}
    
    # Strategy 1: Look for run_config_<phase>.txt paired with <phase>.log
    for phase in PHASE_NAMES:
        config_name = f'run_config_{phase}.txt'
        perf_name = f'{phase}.log'
        
        if config_name in file_names and perf_name in file_names:
            pairs.append((file_names[config_name], file_names[perf_name]))
    
    if pairs:
        return pairs
    
    # Strategy 2: Look for numbered pairs like config1.txt/perf1.txt
    config_files = {}
    perf_files = {}
    
    for name, file in file_names.items():
        # Check for numbered config files
        match = re.match(r'.*config.*?(\d+).*\.(txt|log)$', name)
        if match:
            num = match.group(1)
            config_files[num] = file
            continue
            
        # Check for numbered perf files
        match = re.match(r'.*perf.*?(\d+).*\.(txt|log)$', name)
        if match:
            num = match.group(1)
            perf_files[num] = file
            continue
    
    # Match numbered pairs
    for num in sorted(config_files.keys()):
        if num in perf_files:
            pairs.append((config_files[num], perf_files[num]))
    
    if pairs:
        return pairs
    
    # Strategy 3: Single config/perf pair
    config_patterns = [r'.*config.*\.(txt|log)$', r'OPTIONS-\d+$']
    perf_patterns = [r'.*perf.*\.(txt|log)$', r'.*trace.*\.log$']
    
    config = None
    perf = None
    
    for name, file in file_names.items():
        for pattern in config_patterns:
            if re.match(pattern, name):
                config = file
                break
        for pattern in perf_patterns:
            if re.match(pattern, name):
                perf = file
                break
    
    if config and perf:
        pairs.append((config, perf))
    
    return pairs


def generate_trace_name(directory: Path) -> str:
    """Generate a trace name from the directory name."""
    name = directory.name
    # Clean up the name
    name = re.sub(r'[^\w\-_]', '_', name)
    return name


@click.command('quick')
@click.argument('run_directory', type=click.Path(exists=True, file_okay=False, resolve_path=True))
@click.option('-o', '--output', 'output_file', type=click.Path(path_type=Path), default=None,
              help='Output JSON file (default: <run_directory>/<name>.json)')
@click.option('-n', '--name', 'trace_name', help='Override the trace name (default: directory name)')
@click.option('-c', '--config', 'config_file', type=str,
              help='YAML/JSON config file or catalog name (e.g., "rocksdb", "wiredtiger")')
def quick(run_directory: str, output_file: Path | None, trace_name: str | None, config_file: str | None):
    """Quick workflow: auto-detect logs and parse.
    
    Automatically finds config and perf log files in RUN_DIRECTORY
    and parses them into a trace JSON file.
    
    \b
    Example:
        keigo-parser quick ~/rocksdb-runs/50M_hybrid/
        keigo-parser quick ~/rocksdb-runs/50M_hybrid/ -o output.json
        keigo-parser quick ~/rocksdb-runs/50M_hybrid/ -c rocksdb
    """
    run_path = Path(run_directory)
    
    log_info(f"Scanning directory: [cyan]{run_path}[/]")
    
    # Find config/perf pairs
    pairs = find_phase_pairs(run_path)
    
    if not pairs:
        log_error("Could not find config/perf log file pairs")
        log_info("Expected files matching patterns like:")
        log_info("  - config.txt, config1.txt, rocksdb_config.log")
        log_info("  - perf.txt, perf1.txt, rocksdb_perf.log")
        raise click.Abort()
    
    # Generate trace name if not provided
    if not trace_name:
        trace_name = generate_trace_name(run_path)
    
    log_info(f"Found [green]{len(pairs)}[/] phase(s)")
    for i, (config, perf) in enumerate(pairs):
        log_info(f"  Phase {i}: [dim]{config.name}[/] + [dim]{perf.name}[/]")
    
    # Find the visual_profile.log file
    visual_profile = run_path / 'visual_profile.log'
    if not visual_profile.exists():
        # Try to find any visual profile log
        for f in run_path.iterdir():
            if 'visual' in f.name.lower() and f.suffix == '.log':
                visual_profile = f
                break
    
    if not visual_profile.exists():
        log_error(f"Could not find visual_profile.log in {run_path}")
        raise click.Abort()
    
    # Determine output file (must be absolute since parser runs from different cwd)
    if output_file is None:
        name = trace_name if trace_name else run_path.name
        output_file = run_path / f"{name}.json"
    output_file = output_file.resolve()
    
    # Ensure output directory exists
    output_file.parent.mkdir(parents=True, exist_ok=True)
    
    success, _ = run_parser(
        input_file=visual_profile,
        output_file=output_file,
        config_file=config_file,
        phases=pairs,
        name=trace_name,
    )
    
    if not success:
        log_error("Failed to parse trace logs")
        raise click.Abort()
    
    log_success(f"Trace ready: [cyan]{output_file}[/]")
    log_info("Use the Keigo visualizer to view this trace")
