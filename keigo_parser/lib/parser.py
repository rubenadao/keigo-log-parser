"""
Parser wrapper for keigo-log-parser Node.js script.
"""

import subprocess
import json
from pathlib import Path
from typing import List, Optional, Tuple

from .common import (
    get_parser_dir, get_configs_dir, log_info, log_error, log_success, check_node
)


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
    stdout: bool = False,
) -> Tuple[bool, Optional[Path]]:
    """
    Run the keigo-log-parser on a trace log file.
    
    Args:
        input_file: Path to the input trace log file
        output_file: Path for output JSON (optional, auto-generated if not provided)
        config_file: Path to YAML/JSON config file for tier patterns, labels, phases
        phases: List of (config_file, perf_log_file) tuples
        name: Trace name for auto-generated output filename
        stdout: If True, output to stdout instead of file
        
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
    
    if not input_file.exists():
        log_error(f"Input file not found: {input_file}")
        return False, None
    
    # Determine output file
    final_output = output_file
    if not stdout and output_file is None:
        if name:
            final_output = Path.cwd() / f"{name}.json"
        else:
            final_output = Path.cwd() / f"{input_file.stem}.json"
    
    # Build command
    if stdout:
        cmd = ['node', str(parser_script), str(input_file)]
    else:
        cmd = ['node', str(parser_script), str(input_file), str(final_output)]
    
    # Add config file if provided (resolve catalog names)
    if config_file:
        resolved_config = get_config_path(config_file)
        if not resolved_config.exists():
            available = list_available_configs()
            log_error(f"Config file not found: {config_file}")
            if available:
                log_info(f"Available configs: {', '.join(available)}")
            return False, None
        cmd.extend(['--config', str(resolved_config)])
    
    # Add phase arguments
    if phases:
        for config, perf_log in phases:
            cmd.extend(['--phase', str(config), str(perf_log)])
    
    if not stdout:
        log_info(f"Parsing [cyan]{input_file.name}[/] → [cyan]{final_output.name}[/]")
    
    try:
        result = subprocess.run(
            cmd,
            cwd=str(parser_dir),
            capture_output=not stdout,
            text=True
        )
        
        if stdout:
            return True, None
        
        # Parser outputs to stderr for logging
        if result.stderr:
            for line in result.stderr.strip().split('\n'):
                if line and not any(skip in line for skip in ['Parsing:', 'Output written to:']):
                    print(f"  {line}")
        
        if result.returncode != 0:
            log_error(f"Parser failed with exit code {result.returncode}")
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
