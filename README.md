# keigo-log-parser

Parses RocksDB visual profiler logs into JSON.

## Usage

Point it at a run directory and it figures out the rest:

```bash
pip install -e .
keigo-parser quick ~/runs/my_experiment/
```

Output goes to `~/runs/my_experiment/my_experiment.json`.

## Options

```bash
keigo-parser quick ~/runs/my_experiment/ -o output.json   # custom output path
keigo-parser quick ~/runs/my_experiment/ -c rocksdb       # use a config
```

## Configs

Configs define how to parse different storage engines. They map log fields to visualization properties.

See available configs:
```bash
keigo-parser configs
```

Built-in: `rocksdb`, `rocksdb-tiered`, `wiredtiger`, `leveldb`, `postgres`
