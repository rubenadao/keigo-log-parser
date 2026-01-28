"""
Configs command for Keigo Parser CLI.

Lists available configuration files from the catalog.
"""

import click
from pathlib import Path

from .lib.common import log_info, get_configs_dir


@click.command('configs')
@click.option('--show', '-s', type=str, default=None,
              help='Show contents of a specific config')
def configs(show: str | None) -> None:
    """List available configuration files.
    
    Shows pre-defined configs for different storage engines (RocksDB, WiredTiger, etc.)
    
    \b
    Examples:
      keigo-parser configs              # List all configs
      keigo-parser configs -s rocksdb   # Show rocksdb.yaml contents
    """
    catalog_dir = get_configs_dir()
    
    if not catalog_dir.exists():
        log_info("No configs directory found")
        return
    
    if show:
        # Show specific config
        config_path = None
        for ext in ['.yaml', '.yml', '.json']:
            candidate = catalog_dir / f"{show}{ext}"
            if candidate.exists():
                config_path = candidate
                break
        
        if not config_path:
            click.echo(click.style(f"✗ Config not found: {show}", fg='red'))
            return
        
        click.echo(click.style(f"ℹ {config_path.name}:", fg='cyan'))
        click.echo()
        click.echo(config_path.read_text())
        return
    
    # List all configs
    configs_list = []
    for f in sorted(catalog_dir.iterdir()):
        if f.suffix in ['.yaml', '.yml', '.json']:
            configs_list.append(f)
    
    if not configs_list:
        log_info("No configs found")
        return
    
    log_info("Available configurations:")
    click.echo()
    
    for config_path in configs_list:
        # Read first line (comment) as description
        content = config_path.read_text()
        first_line = content.split('\n')[0] if content else ''
        description = first_line.lstrip('#').strip() if first_line.startswith('#') else ''
        
        name = config_path.stem
        styled_name = click.style(f"{name:20}", fg='cyan')
        click.echo(f"  {styled_name} {description}")
    
    click.echo()
    log_info("Use: keigo-parser parse trace.log -c <config_name>")
    log_info("Or:  keigo-parser configs -s <config_name>  to view details")
