"""
Common utilities for Keigo Parser CLI.
"""

import os
import sys
from pathlib import Path
from typing import Optional

from rich.console import Console

console = Console()


def log_info(msg: str) -> None:
    """Print an info message."""
    console.print(f"[blue]ℹ[/blue] {msg}")


def log_success(msg: str) -> None:
    """Print a success message."""
    console.print(f"[green]✓[/green] {msg}")


def log_warn(msg: str) -> None:
    """Print a warning message."""
    console.print(f"[yellow]⚠[/yellow] {msg}", style="yellow")


def log_error(msg: str) -> None:
    """Print an error message."""
    console.print(f"[red]✗[/red] {msg}", style="red")


def print_header(msg: str) -> None:
    """Print a section header."""
    console.print(f"\n[bold cyan]{'═' * 60}[/bold cyan]")
    console.print(f"[bold cyan]  {msg}[/bold cyan]")
    console.print(f"[bold cyan]{'═' * 60}[/bold cyan]\n")


def get_parser_dir() -> Path:
    """Get the keigo-log-parser directory (this package's root)."""
    # Go up from lib/ to cli/ to keigo_parser/ to keigo-log-parser/
    return Path(__file__).resolve().parent.parent.parent.parent


def get_configs_dir() -> Path:
    """Get the configs directory."""
    return get_parser_dir() / 'configs'


def check_node() -> bool:
    """Check if Node.js is available."""
    import shutil
    return shutil.which('node') is not None


def resolve_output_path(
    output_file: Optional[Path],
    output_dir: Optional[Path],
    trace_name: Optional[str],
    input_file: Path,
    default_output_dir: Optional[Path] = None,
) -> Path:
    """
    Resolve the output file path based on provided options.
    
    Priority:
    1. Explicit output_file
    2. output_dir + trace_name
    3. output_dir + input_file stem
    4. default_output_dir + trace_name
    5. default_output_dir + input_file stem
    6. Current directory + trace_name or input_file stem
    """
    if output_file:
        return output_file
    
    name = trace_name if trace_name else input_file.stem
    filename = f"{name}.json"
    
    if output_dir:
        return output_dir / filename
    
    if default_output_dir:
        return default_output_dir / filename
    
    return Path.cwd() / filename
