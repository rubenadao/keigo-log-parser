"""
Parser wrapper for keigo-log-parser Node.js script.
"""

import subprocess
import json
import re
from pathlib import Path
from typing import List, Optional, Tuple, TYPE_CHECKING

from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn, TimeElapsedColumn

from .common import (
    get_parser_dir, get_configs_dir, log_info, log_error, log_success, check_node, console
)

if TYPE_CHECKING:
    from .manifest import ManifestData


def get_config_path(config: Path | str) -> Path:
    """
    Resolve a config file path.
    
    Supports:
    - Full path: /path/to/config.yaml
    - Relative path: ./config.yaml
    - Catalog name: rocksdb (resolves to configs/rocksdb.yaml)
    """
    if isinstance(config, Path):
        return config
    
    config_path = Path(config)
    
    # If it's already a valid file path, use it
    if config_path.is_file():
        return config_path
    
    # Try as catalog name (e.g., "rocksdb" -> "configs/rocksdb.yaml")
    catalog_dir = get_configs_dir()
    
    # Try with .yaml extension
    catalog_path = catalog_dir / f"{config}.yaml"
    if catalog_path.exists():
        return catalog_path
    
    # Try with .yml extension
    catalog_path = catalog_dir / f"{config}.yml"
    if catalog_path.exists():
        return catalog_path
    
    # Try with .json extension
    catalog_path = catalog_dir / f"{config}.json"
    if catalog_path.exists():
        return catalog_path
    
    # Return original path (will fail with proper error later)
    return config_path


def list_available_configs() -> list[str]:
    """List available config names from the catalog."""
    catalog_dir = get_configs_dir()
    
    if not catalog_dir.exists():
        return []
    
    configs = []
    for f in catalog_dir.iterdir():
        if f.suffix in ['.yaml', '.yml', '.json'] and f.name != 'README.md':
            configs.append(f.stem)
    
    return sorted(configs)


def run_parser(
    input_file: Path,
    output_file: Optional[Path] = None,
    config_file: Optional[Path | str] = None,
    phases: Optional[List[Tuple[Path, Path]]] = None,
    name: Optional[str] = None,
    sequence_sample: Optional[int] = None,
    stdout: bool = False,
    manifest: Optional['ManifestData'] = None,
) -> Tuple[bool, Optional[Path]]:
    """
    Run the keigo-log-parser on a trace log file.
    
    Args:
        input_file: Path to the input trace log file
        output_file: Path for output JSON (optional, auto-generated if not provided)
        config_file: Path to YAML/JSON config file for tier patterns, labels, phases
        phases: List of (config_file, perf_log_file) tuples
        name: Trace name for auto-generated output filename
        sequence_sample: Keep every Nth sequence/frame (e.g., 10 = 10% of frames)
        stdout: If True, output to stdout instead of file
        manifest: Parsed manifest data (optional, for sampling rate)
        
    Returns:
        Tuple of (success: bool, output_path: Path or None)
    """
    if not check_node():
        log_error("Node.js is not installed or not in PATH")
        return False, None
    
    parser_dir = get_parser_dir()
    parser_script = parser_dir / 'main.js'
    
    if not parser_script.exists():
        log_error(f"Parser script not found: {parser_script}")
        return False, None
    
    # Convert to absolute path since we run from a different cwd
    input_file = input_file.resolve()
    
    if not input_file.exists():
        log_error(f"Input file not found: {input_file}")
        return False, None
    
    # Determine output file (use absolute paths since we run from a different cwd)
    final_output = output_file.resolve() if output_file else None
    if not stdout and final_output is None:
        if name:
            final_output = Path.cwd() / f"{name}.json"
        else:
            final_output = Path.cwd() / f"{input_file.stem}.json"
    
    # Build command with increased heap for large files
    node_args = ['node', '--max-old-space-size=8192']
    if stdout:
        cmd = node_args + [str(parser_script), str(input_file)]
    else:
        cmd = node_args + [str(parser_script), str(input_file), str(final_output)]
    
    # Add config file if provided (resolve catalog names)
    if config_file:
        resolved_config = get_config_path(config_file).resolve()
        if not resolved_config.exists():
            available = list_available_configs()
            log_error(f"Config file not found: {config_file}")
            if available:
                log_info(f"Available configs: {', '.join(available)}")
            return False, None
        cmd.extend(['--config', str(resolved_config)])
    
    # Add phase arguments (resolve to absolute paths)
    if phases:
        for config, perf_log in phases:
            cmd.extend(['--phase', str(config.resolve()), str(perf_log.resolve())])
    
    # Add sampling rate from manifest if provided
    if manifest and manifest.cache_sampling_rate is not None:
        cmd.extend(['--sampling-rate', str(manifest.cache_sampling_rate)])
    
    # Add sequence sampling if provided
    if sequence_sample is not None and sequence_sample > 1:
        cmd.extend(['--sequence-sample', str(sequence_sample)])

    if not stdout:
        log_info(f"Parsing [cyan]{input_file.name}[/] → [cyan]{final_output.name}[/]")
    
    try:
        # Use Popen to stream stderr in real-time for progress tracking
        process = subprocess.Popen(
            cmd,
            cwd=str(parser_dir),
            stdout=subprocess.PIPE if not stdout else None,
            stderr=subprocess.PIPE,
            text=True
        )
        
        if stdout:
            process.wait()
            return True, None
        
        # Track progress by parsing stderr output
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            TimeElapsedColumn(),
            console=console,
            transient=True,
        ) as progress:
            read_task = progress.add_task("[cyan]Reading log...", total=100)
            hits_task = None
            tiers_task = None
            validate_task = None
            write_task = None
            total_lines = None
            
            for line in iter(process.stderr.readline, ''):
                line = line.strip()
                if not line:
                    continue
                
                # Parse progress updates from Node.js parser
                # "Processed 1M lines..." or "Processed 25344054 lines total"
                match = re.match(r'Processed (\d+)M? lines', line)
                if match:
                    lines_processed = int(match.group(1))
                    if 'M' in line:
                        lines_processed *= 1_000_000
                    if 'total' in line:
                        total_lines = lines_processed
                        progress.update(read_task, completed=100, total=100, 
                                       description=f"[green]✓ Read {total_lines:,} lines")
                    else:
                        # Estimate progress (assume ~30M lines for large files)
                        estimated_pct = min(95, int((lines_processed / 30_000_000) * 100))
                        progress.update(read_task, completed=estimated_pct,
                                       description=f"[cyan]Reading... {lines_processed:,} lines")
                    continue
                
                # "Processing hits: 50%"
                match = re.match(r'Processing hits.*?(\d+)%', line)
                if match:
                    percent = int(match.group(1))
                    if hits_task is None:
                        progress.update(read_task, completed=100, total=100,
                                       description=f"[green]✓ Read {total_lines:,} lines" if total_lines else "[green]✓ Read complete")
                        hits_task = progress.add_task("[cyan]Processing hits...", total=100)
                    progress.update(hits_task, completed=percent,
                                   description=f"[cyan]Processing hits... {percent}%")
                    continue
                
                # "Applying tiers: 50%"
                match = re.match(r'Applying tiers.*?(\d+)%', line)
                if match:
                    percent = int(match.group(1))
                    if tiers_task is None:
                        if hits_task:
                            progress.update(hits_task, completed=100, total=100,
                                           description=f"[green]✓ Processed hits")
                        tiers_task = progress.add_task("[cyan]Applying tiers...", total=100)
                    progress.update(tiers_task, completed=percent,
                                   description=f"[cyan]Applying tiers... {percent}%")
                    continue
                
                # "Validating: 50%"
                match = re.match(r'Validating.*?(\d+)%', line)
                if match:
                    percent = int(match.group(1))
                    if validate_task is None:
                        if tiers_task:
                            progress.update(tiers_task, completed=100, total=100,
                                           description=f"[green]✓ Applied tiers")
                        validate_task = progress.add_task("[cyan]Validating...", total=100)
                    progress.update(validate_task, completed=percent,
                                   description=f"[cyan]Validating... {percent}%")
                    continue
                
                # "Writing JSON: 50%"
                match = re.match(r'Writing JSON: (\d+)%', line)
                if match:
                    percent = int(match.group(1))
                    if write_task is None:
                        if validate_task:
                            progress.update(validate_task, completed=100, total=100,
                                           description=f"[green]✓ Validated")
                        write_task = progress.add_task("[cyan]Writing JSON...", total=100)
                    progress.update(write_task, completed=percent,
                                   description=f"[cyan]Writing JSON... {percent}%")
                    continue
                
                # Other lines (config loaded, etc) - display them
                if any(skip in line for skip in ['Parsing:', 'Output written to:']):
                    continue
                console.print(f"  {line}")
        
        process.wait()
        
        if process.returncode != 0:
            log_error(f"Parser failed with exit code {process.returncode}")
            return False, None
        
        if final_output and final_output.exists():
            log_success(f"Output written to [cyan]{final_output}[/]")
            return True, final_output
        else:
            log_error("Parser completed but output file not found")
            return False, None
            
    except Exception as e:
        log_error(f"Failed to run parser: {e}")
        return False, None


def get_trace_info(trace_path: Path) -> Optional[dict]:
    """
    Get information about a trace file.
    
    Returns dict with:
    - name: Trace name (filename without extension)
    - size_bytes: File size in bytes
    - frames: Number of frames
    - phases: Number of phases
    - has_cache: Whether cache data is present
    - cache_instances: List of cache instance names
    """
    if not trace_path.exists():
        return None
    
    info = {
        'name': trace_path.stem,
        'path': str(trace_path),
        'size_bytes': trace_path.stat().st_size,
        'frames': 0,
        'phases': 0,
        'has_cache': False,
        'cache_instances': [],
    }
    
    try:
        with open(trace_path, 'r') as f:
            data = json.load(f)
        
        if isinstance(data, dict):
            if 'frames' in data:
                info['frames'] = len(data['frames'])
            if 'phases' in data:
                info['phases'] = len(data['phases'])
            if 'cache' in data:
                info['has_cache'] = True
                if isinstance(data['cache'], dict):
                    info['cache_instances'] = list(data['cache'].keys())
    except (json.JSONDecodeError, KeyError):
        pass
    
    return info
