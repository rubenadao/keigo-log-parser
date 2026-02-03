"""Quick command - auto-detect and parse in one step."""

import os
import re
import click
from pathlib import Path
from typing import TYPE_CHECKING

from .lib.common import log_info, log_success, log_warn, log_error, resolve_output_path
from .lib.parser import run_parser
from .lib.manifest import load_manifest, get_trace_file, get_sampling_rate

if TYPE_CHECKING:
    from .lib.manifest import ManifestData


# Phase name patterns - used to detect loading/execution phases
PHASE_NAMES = ['loading', 'execution', 'load', 'exec', 'phase1', 'phase2', 'phase_1', 'phase_2']


def build_phase_pairs_from_manifest(directory: Path, manifest: 'ManifestData') -> list[tuple[Path, Path]]:
    """Build phase pairs from manifest data.
    
    Supports two manifest styles:
    1. run_bench.sh style: files.output = "output.log" (single file)
    2. legokv-cli style: files.output = directory, phases = ["loading", "execution"]
    
    Returns:
        List of (config_file, perf_log_file) tuples
    """
    pairs = []
    
    # Get output log path from manifest (run_bench.sh style)
    if manifest.output_file:
        output_path = directory / manifest.output_file
        # Only use if it's a file (not a directory)
        if output_path.exists() and output_path.is_file():
            # Use manifest.yaml as the config file (it contains command args)
            manifest_path = directory / 'manifest.yaml'
            if not manifest_path.exists():
                manifest_path = directory / 'manifest.yml'
            
            if manifest_path.exists():
                pairs.append((manifest_path, output_path))
                log_info(f"Performance data: [dim]{manifest.output_file}[/]")
    
    # Check for explicit run_config files (legokv-cli style multi-phase runs)
    for phase in PHASE_NAMES:
        config_yaml = directory / f'run_config_{phase}.yaml'
        config_txt = directory / f'run_config_{phase}.txt'
        perf_log = directory / f'{phase}.log'
        
        config_file = config_yaml if config_yaml.exists() else (config_txt if config_txt.exists() else None)
        
        if config_file and perf_log.exists():
            pairs.append((config_file, perf_log))
            log_info(f"Phase [{phase}]: [dim]{config_file.name}[/] + [dim]{perf_log.name}[/]")
    
    return pairs


def find_phase_pairs(directory: Path) -> list[tuple[Path, Path]]:
    """Find config/perf file pairs in the directory (legacy detection).
    
    Supports naming conventions:
    - run_config_loading.txt / loading.log
    - run_config_execution.txt / execution.log  
    - config1.txt / perf1.txt
    - config.txt / perf.txt
    """
    pairs = []
    files = list(directory.iterdir())
    file_names = {f.name.lower(): f for f in files if f.is_file()}
    
    # Strategy 1: Look for run_config_<phase>.yaml/.txt paired with <phase>.log
    for phase in PHASE_NAMES:
        # Try yaml first, then txt
        config_yaml = f'run_config_{phase}.yaml'
        config_txt = f'run_config_{phase}.txt'
        perf_name = f'{phase}.log'
        
        config_name = config_yaml if config_yaml in file_names else config_txt
        
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
@click.option('-o', '--output', 'output_file', type=click.Path(path_type=Path), required=True,
              help='Output JSON file')
@click.option('-n', '--name', 'trace_name', help='Override the trace name (default: directory name)')
@click.option('-c', '--config', 'config_file', type=str,
              help='YAML/JSON config file or catalog name (e.g., "rocksdb", "wiredtiger")')
def quick(run_directory: str, output_file: Path, trace_name: str | None, config_file: str | None):
    """Quick workflow: auto-detect logs and parse.
    
    Automatically finds config and perf log files in RUN_DIRECTORY
    and parses them into a trace JSON file.
    
    Supports both:
    - New manifest.yaml format (from run_bench.sh wrapper)
    - Legacy legokv-cli format (run_config_*.txt files)
    
    \b
    Example:
        keigo-parser quick ~/rocksdb-runs/50M_hybrid/ -o output.json
        keigo-parser quick ~/rocksdb-runs/50M_hybrid/ -o trace.json -c rocksdb
    """
    run_path = Path(run_directory)
    
    log_info(f"Scanning directory: [cyan]{run_path}[/]")
    
    # Try to load manifest first (new format)
    manifest = load_manifest(run_path)
    
    if manifest:
        log_info(f"Using manifest: generator=[green]{manifest.generator}[/]")
        
        # Get trace file from manifest
        visual_profile = get_trace_file(run_path, manifest)
        if not visual_profile:
            log_error("Manifest specifies no trace file, or trace file not found")
            raise click.Abort()
        
        # Build phase pairs from manifest
        # Performance charts come from the output log (stats_interval_seconds data)
        pairs = build_phase_pairs_from_manifest(run_path, manifest)
        
        # Use run name from manifest if not overridden
        if not trace_name:
            trace_name = manifest.run_name
    else:
        # Fall back to legacy detection
        log_info("No manifest found, using legacy detection")
        
        # Find config/perf pairs (legacy)
        pairs = find_phase_pairs(run_path)
        
        if not pairs:
            log_warn("No config/perf file pairs found")
            log_info("Looking for visual_profile.log directly...")
        
        # Find the visual_profile.log file
        visual_profile = get_trace_file(run_path)
        
        if not visual_profile:
            log_error(f"Could not find visual_profile.log in {run_path}")
            raise click.Abort()
        
        # Generate trace name if not provided
        if not trace_name:
            trace_name = generate_trace_name(run_path)
    
    # Log what we found
    if pairs:
        log_info(f"Found [green]{len(pairs)}[/] phase(s)")
        for i, (config, perf) in enumerate(pairs):
            log_info(f"  Phase {i}: [dim]{config.name}[/] + [dim]{perf.name}[/]")
    
    log_info(f"Trace file: [cyan]{visual_profile.name}[/]")
    
    # Resolve output file path (must be absolute since parser runs from different cwd)
    output_file = output_file.resolve()
    
    # Ensure output directory exists
    output_file.parent.mkdir(parents=True, exist_ok=True)
    
    # Pass manifest to parser for sampling rate extraction
    success, _ = run_parser(
        input_file=visual_profile,
        output_file=output_file,
        config_file=config_file,
        phases=pairs if pairs else None,
        name=trace_name,
        manifest=manifest,
    )
    
    if not success:
        log_error("Failed to parse trace logs")
        raise click.Abort()
    
    log_success(f"Trace ready: [cyan]{output_file}[/]")
    log_info("Use the Keigo visualizer to view this trace")
