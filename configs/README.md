# Keigo Configuration Catalog

Pre-defined configuration files for different storage engines and databases.

## Usage

```bash
# Use a config from the catalog
node main.js trace.log output.json --config configs/rocksdb.yaml

# With keigo CLI
keigo parse trace.log -c configs/rocksdb.yaml
keigo quick ./runs/my_run -c configs/rocksdb-tiered.yaml
```

## Available Configs

| Config | Description |
|--------|-------------|
| `rocksdb.yaml` | RocksDB with BlobDB (SSTs + Blobs) |
| `rocksdb-tiered.yaml` | RocksDB with local/remote tiered storage |
| `leveldb.yaml` | LevelDB |
| `wiredtiger.yaml` | WiredTiger (MongoDB storage engine) |
| `postgres.yaml` | PostgreSQL |

## Config Format

```yaml
# Tiers define storage locations
# Files are assigned based on regex patterns (first match wins)
tiers:
  - name: "Tier Name"
    patterns:
      - "\\.sst$"    # Regex patterns for filenames

# Labels define colors for file categories/levels
# Keys are level numbers or custom strings
labels:
  "0": 0xFFFF00      # Hex color (0xRRGGBB)
  "-1": 0x808080     # Files without a level

# Phase names (override auto-detected PHASE0, PHASE1, etc.)
phases:
  - "Loading"
  - "Execution"

# Enable/disable cache visualization
cache: true
```

## Creating Custom Configs

1. Copy an existing config as a template
2. Modify tier patterns to match your file naming conventions
3. Adjust labels/colors as needed
4. Save with a descriptive name (e.g., `mydb-tiered.yaml`)
