"""
Manifest loading utilities for Keigo Parser.

Provides functions to load and parse manifest.yaml files that describe
benchmark run outputs. Falls back to legacy detection if no manifest exists.
"""

from pathlib import Path
from typing import Optional, Any
from dataclasses import dataclass

try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False

from .common import log_info, log_warn


@dataclass
class ManifestData:
    """Parsed manifest data."""
    # Required
    schema_version: str
    generator: str
    run_name: str
    timestamp: str
    exit_code: int
    
    # Files
    output_file: Optional[str] = None
    trace_file: Optional[str] = None
    
    # Optional sampling (only if visual profiling enabled)
    cache_sampling_rate: Optional[int] = None
    blob_cache_sampling_rate: Optional[int] = None
    
    # Optional command
    executable: Optional[str] = None
    args: Optional[list[str]] = None
    
    # Optional metadata
    hostname: Optional[str] = None
    duration_seconds: Optional[float] = None
    
    # Raw data for extensions
    raw: dict = None


def load_manifest(directory: Path) -> Optional[ManifestData]:
    """
    Load manifest.yaml from a directory if it exists.
    
    Args:
        directory: Path to the results directory
        
    Returns:
        ManifestData if manifest exists and is valid, None otherwise
    """
    manifest_path = directory / 'manifest.yaml'
    
    if not manifest_path.exists():
        # Also try manifest.yml
        manifest_path = directory / 'manifest.yml'
        if not manifest_path.exists():
            return None
    
    if not HAS_YAML:
        log_warn("PyYAML not installed, cannot read manifest.yaml")
        log_warn("Install with: pip install pyyaml")
        return None
    
    try:
        with open(manifest_path, 'r') as f:
            data = yaml.safe_load(f)
    except Exception as e:
        log_warn(f"Failed to parse manifest: {e}")
        return None
    
    if not data:
        return None
    
    # Parse required fields
    try:
        run_data = data.get('run', {})
        files_data = data.get('files', {})
        sampling_data = data.get('sampling', {})
        command_data = data.get('command', {})
        
        manifest = ManifestData(
            schema_version=data.get('schema_version', '1.0'),
            generator=data.get('generator', 'unknown'),
            run_name=run_data.get('name', 'unknown'),
            timestamp=run_data.get('timestamp', ''),
            exit_code=run_data.get('exit_code', 0),
            
            # Files
            output_file=files_data.get('output'),
            trace_file=files_data.get('trace'),
            
            # Sampling - support both 'cache' and 'rate' as keys
            cache_sampling_rate=sampling_data.get('cache') or sampling_data.get('rate'),
            blob_cache_sampling_rate=sampling_data.get('blob_cache'),
            
            # Command
            executable=command_data.get('executable'),
            args=command_data.get('args'),
            
            # Metadata
            hostname=run_data.get('hostname'),
            duration_seconds=run_data.get('duration_seconds'),
            
            # Keep raw data for extensions
            raw=data,
        )
        
        log_info(f"Loaded manifest: generator={manifest.generator}, name={manifest.run_name}")
        return manifest
        
    except Exception as e:
        log_warn(f"Failed to parse manifest fields: {e}")
        return None


def get_trace_file(directory: Path, manifest: Optional[ManifestData] = None) -> Optional[Path]:
    """
    Get the trace file path from a directory.
    
    Uses manifest if available, otherwise falls back to heuristic search.
    
    Args:
        directory: Results directory
        manifest: Parsed manifest data (optional)
        
    Returns:
        Path to trace file if found, None otherwise
    """
    # Try manifest first
    if manifest and manifest.trace_file:
        trace_path = directory / manifest.trace_file
        if trace_path.exists():
            return trace_path
    
    # Fall back to heuristic search
    visual_profile = directory / 'visual_profile.log'
    if visual_profile.exists():
        return visual_profile
    
    # Try to find any visual profile log
    for f in directory.iterdir():
        if f.is_file() and 'visual' in f.name.lower() and f.suffix == '.log':
            return f
    
    return None


def get_sampling_rate(
    directory: Path,
    manifest: Optional[ManifestData] = None,
    phase_files: Optional[list[tuple[Path, Path]]] = None,
) -> int:
    """
    Get the cache sampling rate.
    
    Priority:
    1. Manifest sampling.cache
    2. Legacy: extract from phase config files
    3. Default: 100
    
    Args:
        directory: Results directory
        manifest: Parsed manifest data (optional)
        phase_files: Legacy phase file pairs (optional)
        
    Returns:
        Sampling rate (default: 100)
    """
    # Try manifest first
    if manifest and manifest.cache_sampling_rate is not None:
        log_info(f"Sampling rate from manifest: {manifest.cache_sampling_rate}")
        return manifest.cache_sampling_rate
    
    # Try legacy phase files
    if phase_files:
        import re
        for config_path, _ in phase_files:
            if config_path.exists():
                try:
                    content = config_path.read_text()
                    match = re.search(r'visual_profile_cache_sampling_rate=(\d+)', content)
                    if match:
                        rate = int(match.group(1))
                        log_info(f"Sampling rate from config file: {rate}")
                        return rate
                except Exception:
                    pass
    
    # Default
    log_info("Using default sampling rate: 100")
    return 100
