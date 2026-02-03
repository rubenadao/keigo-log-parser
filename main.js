#!/usr/bin/env node
/**
 * Keigo Log Parser
 * Parses RocksDB visual profiler trace logs into JSON format for the Keigo visualizer.
 * 
 * Usage: node main.js <input_file> [output_file] [options]
 *   input_file  - Path to the trace log file
 *   output_file - Path for the output JSON (default: stdout)
 *   --config    - Optional YAML/JSON config file for tier patterns, labels, phases
 *   --phase     - Optional phase data: config file and performance log file pair
 */

const fs = require('fs');
const path = require('path');

// Optional YAML support - falls back to JSON if js-yaml not available
let yaml = null;
try {
    yaml = require('js-yaml');
} catch (e) {
    // js-yaml not installed, will use JSON config only
}

// Visualization config loaded from --config file
let vizConfig = null;
const { Sst, Tier, Run } = require('./structs');
const { readModsFromFile } = require('./states');

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    
    if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
        console.log(`
Keigo Log Parser - Parse RocksDB trace logs for visualization

Usage: node main.js <input_file> [output_file] [options]

Arguments:
  input_file   Path to the trace log file (required)
  output_file  Path for the output JSON file (optional, defaults to stdout)

Options:
  --config <file>      YAML/JSON config file for tier patterns, labels, and phases
  --phase <cfg> <log>  Phase data pair: config file and performance log file (repeatable)
  --sampling-rate <n>  Cache sampling rate (default: auto-detect from phase files, or 100)

Examples:
  node main.js trace.log                    # Output to stdout
  node main.js trace.log output.json        # Output to file
  node main.js trace.log output.json --config config.yaml
  node main.js trace.log output.json --sampling-rate 100
  node main.js trace.log output.json --config config.yaml --phase loading.cfg loading.log
`);
        process.exit(args.length === 0 ? 1 : 0);
    }
    
    let inputFile = null;
    let outputFile = null;
    let configFile = null;
    let samplingRateOverride = null;
    const phaseFiles = []; // Array of { config: string, perfLog: string }
    
    let i = 0;
    while (i < args.length) {
        if (args[i] === '--phase') {
            // Expect two arguments after --phase
            if (i + 2 >= args.length) {
                console.error('Error: --phase requires two arguments: <config_file> <perf_log_file>');
                process.exit(1);
            }
            phaseFiles.push({
                config: args[i + 1],
                perfLog: args[i + 2]
            });
            i += 3;
        } else if (args[i] === '--config') {
            // Expect one argument after --config
            if (i + 1 >= args.length) {
                console.error('Error: --config requires a file path');
                process.exit(1);
            }
            configFile = args[i + 1];
            i += 2;
        } else if (args[i] === '--sampling-rate') {
            // Expect one argument after --sampling-rate
            if (i + 1 >= args.length) {
                console.error('Error: --sampling-rate requires a number');
                process.exit(1);
            }
            samplingRateOverride = parseInt(args[i + 1], 10);
            if (isNaN(samplingRateOverride) || samplingRateOverride <= 0) {
                console.error('Error: --sampling-rate must be a positive integer');
                process.exit(1);
            }
            i += 2;
        } else if (!inputFile) {
            inputFile = args[i];
            i++;
        } else if (!outputFile) {
            outputFile = args[i];
            i++;
        } else {
            console.error(`Error: Unexpected argument: ${args[i]}`);
            process.exit(1);
        }
    }
    
    return {
        inputFile,
        outputFile: outputFile || null,
        configFile,
        phaseFiles,
        samplingRateOverride
    };
}

/**
 * Read and parse a YAML or JSON config file
 * Config format:
 * ```yaml
 * tiers:
 *   - name: "Local NVMe"
 *     patterns:
 *       - "\\.sst$"           # SST files
 *       - "MANIFEST-.*"
 *   - name: "Blob Storage"
 *     patterns:
 *       - "\\.blob$"          # Blob files
 * 
 * labels:
 *   "0": 0xFFFF00
 *   "1": 0x008000
 * 
 * phases:
 *   - "Loading"
 *   - "Execution"
 * 
 * cache: true
 * ```
 */
function readConfigFile(configPath) {
    if (!fs.existsSync(configPath)) {
        console.error(`Error: Config file not found: ${configPath}`);
        process.exit(1);
    }
    
    const content = fs.readFileSync(configPath, 'utf-8');
    const ext = path.extname(configPath).toLowerCase();
    
    let config;
    if (ext === '.yaml' || ext === '.yml') {
        if (!yaml) {
            console.error('Error: js-yaml not installed. Install with: npm install js-yaml');
            console.error('       Or use a .json config file instead.');
            process.exit(1);
        }
        config = yaml.load(content);
    } else {
        // Assume JSON
        config = JSON.parse(content);
    }
    
    // Compile regex patterns for each tier
    if (config.tiers) {
        config.tiers.forEach((tier, index) => {
            tier.index = index + 1;  // 1-based tier index
            tier.compiledPatterns = (tier.patterns || []).map(p => new RegExp(p));
        });
    }
    
    console.error(`Loaded config: ${configPath}`);
    return config;
}

/**
 * Determine which tier a file belongs to based on config patterns
 * Returns the tier index (1-based) or the default tier if no match
 */
function getTierForFile(filename, defaultTier) {
    if (!vizConfig || !vizConfig.tiers) {
        return defaultTier;
    }
    
    for (const tier of vizConfig.tiers) {
        for (const pattern of tier.compiledPatterns || []) {
            if (pattern.test(filename)) {
                return tier.index;
            }
        }
    }
    
    return defaultTier;  // No pattern matched, use trace's tier
}

// Read sampling rate from config file
function readSamplingRate(phaseFiles) {
    // Try to find visual_profile_cache_sampling_rate in any config file
    for (const { config } of phaseFiles) {
        if (fs.existsSync(config)) {
            const content = fs.readFileSync(config, 'utf-8');
            const match = /visual_profile_cache_sampling_rate=(\d+)/.exec(content);
            if (match) {
                const rate = parseInt(match[1], 10);
                console.error(`Found cache sampling rate: ${rate}`);
                return rate;
            }
        }
    }
    console.error('Warning: Cache sampling rate not found in config files, defaulting to 100');
    return 100; // Default
}

// Read phase files and return array of phase data objects
// Files are stored as arrays of lines for better JSON readability
function readPhaseFiles(phaseFiles) {
    return phaseFiles.map(({ config, perfLog }, index) => {
        const phaseData = {
            index,
            config: null,
            perfLog: null
        };
        
        if (fs.existsSync(config)) {
            const content = fs.readFileSync(config, 'utf-8');
            phaseData.config = content.split('\n');
        } else {
            console.error(`Warning: Config file not found: ${config}`);
        }
        
        if (fs.existsSync(perfLog)) {
            const content = fs.readFileSync(perfLog, 'utf-8');
            phaseData.perfLog = content.split('\n');
        } else {
            console.error(`Warning: Performance log file not found: ${perfLog}`);
        }
        
        return phaseData;
    });
}

// Tier and SST state
let tiers = [new Tier(1), new Tier(2), new Tier(3)];
let ssts = {};

// Cache usage tracking per cache instance: Map<cacheInstance, Map<cache_key, block_size>>
// cacheInstance is a string: "" for default, "0", "1", etc. for numbered instances
let cacheBlocksByInstance = new Map();

// Lookup table for cache_key -> {filename, offset, type} to resolve migrations
// When C+0 is logged, we store the filename. When C+1 (migration) comes with "-" as filename,
// we look up the real filename from this map.
let cacheKeyToFileInfo = new Map();

// Blob cache tracking per cache instance: Map<cacheInstance, Map<blob_key, blob_size>>
// Similar structure to block cache
let blobBlocksByInstance = new Map();

// Debug counters for cache events
let cacheInsertCount = 0;
let cacheEvictCount = 0;
let cacheEvictMatchedCount = 0;
let cacheEvictMissedCount = 0;

// Debug counters for blob cache events
let blobInsertCount = 0;
let blobEvictCount = 0;
let blobEvictMatchedCount = 0;
let blobEvictMissedCount = 0;

// Get or create the cache blocks map for a given instance
function getCacheInstance(instanceId) {
    if (!cacheBlocksByInstance.has(instanceId)) {
        cacheBlocksByInstance.set(instanceId, new Map());
    }
    return cacheBlocksByInstance.get(instanceId);
}

// Get or create the blob cache blocks map for a given instance
function getBlobCacheInstance(instanceId) {
    if (!blobBlocksByInstance.has(instanceId)) {
        blobBlocksByInstance.set(instanceId, new Map());
    }
    return blobBlocksByInstance.get(instanceId);
}

const selectTier = (i) => i - 1;

// Command handlers
const modMap = {
    'o': (line) => {
        // Match: o <filename> <tier> [l<label>]  (label is optional for blob files)
        const match = /o ([^ ]+) (\d+)(?: l([^ ]+))?/.exec(line);
        if (!match) return;
        const [, number, defaultTier, label] = match;
        if (ssts[number] === undefined) {
            // Use config patterns to determine tier, or fall back to trace's tier
            const tier = getTierForFile(number, defaultTier);
            const sst = new Sst(number);
            sst.label = label || '-1';  // Default label for files without level
            sst.tier = tier.toString();
            tiers[selectTier(tier)].files.set(number, sst);
            ssts[number] = sst;
        }
    },
    
    's': (line) => {
        // s <sst_number> <size> - SST file size
        const match = /s ([^ ]+) (\d+)/.exec(line);
        if (!match) return;
        const [, number, size] = match;
        const sst = ssts[number];
        if (sst) {
            sst.size = parseInt(size, 10);
        }
    },
    
    'm': (line) => {
        // Match: m <filename> <tier> [l<label>]  (label is optional for blob files)
        const match = /m ([^ ]+) (\d+)(?: l([^ ]+))?/.exec(line);
        if (!match) return;
        const [, number, defaultTier, label] = match;
        const sst = ssts[number];
        if (!sst) return;
        if (label) sst.label = label;  // Only update label if provided
        // Use config patterns to determine tier, or fall back to trace's tier
        const tier = getTierForFile(number, defaultTier);
        if (sst.tier === tier.toString()) return;
        tiers[selectTier(tier)].files.set(number, sst);
        tiers[selectTier(parseInt(sst.tier))].files.delete(number);
        sst.tier = tier.toString();
    },
    
    'h': (line) => {
        const match = /h (\d+) (\d+)/.exec(line);
        if (!match) return;
        const [, number, tier] = match;
        const sst = ssts[number];
        if (sst) {
            tiers[selectTier(tier)].cache.set(number, sst);
        }
    },
    
    'e': (line) => {
        const match = /e (\d+) (\d+)/.exec(line);
        if (!match) return;
        const [, number, tier] = match;
        tiers[selectTier(tier)].cache.delete(number);
    },
    
    'u': (line) => {
        const match = /u ([^ \n]+)/.exec(line);
        if (!match) return;
        const number = match[1];
        const sst = ssts[number];
        if (!sst) return;
        tiers.forEach((tier) => tier.cache.delete(number));
        tiers[selectTier(sst.tier)].files.delete(number);
    },
    
    'l': (line) => {
        const match = /l ([^ ]+) l([^ \n]+)/.exec(line);
        if (!match) return;
        const [, number, label] = match;
        const sst = ssts[number];
        if (sst) {
            sst.label = label;
        }
    },
    
    'r': (line) => {
        const match = /r ([^ ]+) ([^ \n]+)/.exec(line);
        if (!match) return;
        const [, oldNumber, newNumber] = match;
        const sst = ssts[oldNumber];
        if (!sst) return;
        ssts[newNumber] = sst;
        sst.number = newNumber;
        delete ssts[oldNumber];
    },
    
    '#': (line) => {
        const match = /# ([^ ]+) (\d+)/.exec(line);
        if (!match) return;
        const [, number, hits] = match;
        const sst = ssts[number];
        if (sst) {
            sst.hits = hits;
        }
    },
    
    '!': (line) => {
        const match = /! ([^ ]+) (\d+)/.exec(line);
        if (!match) return;
        const [, number, writes] = match;
        const sst = ssts[number];
        if (sst) {
            sst.writes = writes;
        }
    },
    
    'z': () => {}, // Tier stats - no-op
    
    // Block cache events - passed through to visualizer
    'C': (line) => {
        // C+[N] <sst_file.sst> <offset> <size> <type> <key_hex>  - Block cache insert (N is optional cache instance)
        // C+[N] - <size> <was_hit> <key_hex>                      - Block cache migration (filename is "-", lookup from key)
        // C- <key_hex> <was_hit>                                  - Block cache eviction (instance inferred from key)
        if (line.startsWith('C+')) {
            // First try normal insert format: C+[N] <filename> <offset> <size> <type> <key_hex>
            let match = /C\+(\d*) ([^ ]+) (\d+) (\d+) ([^ ]+) ([a-f0-9]+)/.exec(line);
            if (match) {
                const [, cacheInstance, sstFile, offset, size, type, cacheKey] = match;
                const blockSize = parseInt(size, 10);
                const instanceId = cacheInstance || ''; // '' for default instance
                getCacheInstance(instanceId).set(cacheKey, blockSize);
                // Store file info for potential migration lookups
                cacheKeyToFileInfo.set(cacheKey, { filename: sstFile, offset: parseInt(offset, 10), type });
                cacheInsertCount++;
                return;
            }
            
            // Try migration format: C+[N] - <size> <was_hit> <key_hex>
            // Used when block is migrated to secondary cache (no filename in log, use "-" placeholder)
            match = /C\+(\d+) - (\d+) ([01]) ([a-f0-9]+)/.exec(line);
            if (match) {
                const [, cacheInstance, size, wasHit, cacheKey] = match;
                const blockSize = parseInt(size, 10);
                const instanceId = cacheInstance;
                getCacheInstance(instanceId).set(cacheKey, blockSize);
                // Lookup the original filename from our cache key map
                const fileInfo = cacheKeyToFileInfo.get(cacheKey);
                if (fileInfo) {
                    // File info is already stored, we can use it for reporting
                    // The migration is to a different cache instance but same file/offset
                }
                cacheInsertCount++;
                return;
            }
            
            console.error(`Warning: Invalid C+ line format: ${line}`);
        } else if (line.startsWith('C-')) {
            // C- <key_hex> <was_hit> - no instance number needed, infer from key
            const match = /C- ([a-f0-9]+) ([01])/.exec(line);
            if (!match) {
                console.error(`Warning: Invalid C- line format: ${line}`);
                return;
            }
            const [, cacheKey, wasHit] = match;
            cacheEvictCount++;
            // Find and remove from whichever cache instance has this key
            let found = false;
            for (const [instanceId, cacheBlocks] of cacheBlocksByInstance.entries()) {
                if (cacheBlocks.has(cacheKey)) {
                    cacheBlocks.delete(cacheKey);
                    cacheEvictMatchedCount++;
                    found = true;
                    break;
                }
            }
            if (!found) {
                cacheEvictMissedCount++;
            }
        }
    },
    
    // Blob cache events - similar to block cache but for blob files
    'B': (line) => {
        // B+ <sst_file.sst> <offset> <size> <blob_key_hex>  - Blob cache insert
        // B- <blob_key_hex> <was_hit>                        - Blob cache eviction
        if (line.startsWith('B+')) {
            // Match B+ followed by sst file, offset, size, and key
            const match = /B\+ ([^ ]+) (\d+) (\d+) ([a-f0-9]+)/.exec(line);
            if (!match) {
                console.error(`Warning: Invalid B+ line format: ${line}`);
                return;
            }
            const [, sstFile, offset, size, blobKey] = match;
            const blobSize = parseInt(size, 10);
            // Use default instance for now (blob cache doesn't have instance numbers yet)
            getBlobCacheInstance('').set(blobKey, blobSize);
            blobInsertCount++;
        } else if (line.startsWith('B-')) {
            // B- <blob_key_hex> <was_hit>
            const match = /B- ([a-f0-9]+) ([01])/.exec(line);
            if (!match) {
                console.error(`Warning: Invalid B- line format: ${line}`);
                return;
            }
            const [, blobKey, wasHit] = match;
            blobEvictCount++;
            // Find and remove from whichever blob cache instance has this key
            let found = false;
            for (const [instanceId, blobBlocks] of blobBlocksByInstance.entries()) {
                if (blobBlocks.has(blobKey)) {
                    blobBlocks.delete(blobKey);
                    blobEvictMatchedCount++;
                    found = true;
                    break;
                }
            }
            if (!found) {
                blobEvictMissedCount++;
            }
        }
    }
};

// Process sequences to handle hit resets
function processSequences(sequences) {
    function extractHits(mods) {
        const hits = new Set();
        mods.forEach(mod => {
            const parts = mod.split(' ');
            if (parts[0] === '#') {
                hits.add(parts[1]);
            }
        });
        return hits;
    }

    const processedSequences = [];
    let previousHits = new Set();

    sequences.forEach(seq => {
        const currentHits = extractHits(seq.mods);
        previousHits.forEach(sst => {
            if (!currentHits.has(sst)) {
                seq.mods.push(`# ${sst} 0`);
            }
        });
        processedSequences.push(seq);
        previousHits = currentHits;
    });

    return processedSequences;
}

/**
 * Rewrite trace lines to apply tier patterns from config.
 * This modifies 'o' and 'm' commands to use the tier determined by regex patterns.
 */
function applyTierPatterns(sequences) {
    if (!vizConfig || !vizConfig.tiers) {
        return sequences;
    }
    
    return sequences.map(seq => {
        const newMods = seq.mods.map(mod => {
            // Match 'o' command: o <filename> <tier> [l<label>]
            let match = /^o ([^ ]+) (\d+)(?: l([^ ]+))?$/.exec(mod);
            if (match) {
                const [, filename, defaultTier, label] = match;
                const newTier = getTierForFile(filename, defaultTier);
                if (label) {
                    return `o ${filename} ${newTier} l${label}`;
                } else {
                    return `o ${filename} ${newTier}`;
                }
            }
            
            // Match 'm' command: m <filename> <tier> [l<label>]
            match = /^m ([^ ]+) (\d+)(?: l([^ ]+))?$/.exec(mod);
            if (match) {
                const [, filename, defaultTier, label] = match;
                const newTier = getTierForFile(filename, defaultTier);
                if (label) {
                    return `m ${filename} ${newTier} l${label}`;
                } else {
                    return `m ${filename} ${newTier}`;
                }
            }
            
            // Match 'h' command: h <filename> <tier>
            match = /^h ([^ ]+) (\d+)$/.exec(mod);
            if (match) {
                const [, filename, defaultTier] = match;
                const newTier = getTierForFile(filename, defaultTier);
                return `h ${filename} ${newTier}`;
            }
            
            // Match 'e' command: e <filename> <tier>
            match = /^e ([^ ]+) (\d+)$/.exec(mod);
            if (match) {
                const [, filename, defaultTier] = match;
                const newTier = getTierForFile(filename, defaultTier);
                return `e ${filename} ${newTier}`;
            }
            
            return mod;  // No change
        });
        
        return { ...seq, mods: newMods };
    });
}

// Main execution
function main() {
    const { inputFile, outputFile, configFile, phaseFiles, samplingRateOverride } = parseArgs();
    
    // Check input file exists
    if (!fs.existsSync(inputFile)) {
        console.error(`Error: Input file not found: ${inputFile}`);
        process.exit(1);
    }
    
    // Load visualization config if provided
    if (configFile) {
        vizConfig = readConfigFile(configFile);
    }
    
    console.error(`Parsing: ${inputFile}`);
    
    // Read and parse the trace file
    const data = readModsFromFile(inputFile);
    let modSeqs = data.sequences;
    
    // Process sequences
    modSeqs = processSequences(modSeqs);
    
    // Apply tier patterns from config (rewrites trace lines)
    modSeqs = applyTierPatterns(modSeqs);
    
    data.sequences = modSeqs;
    
    // Read phase files and sampling rate if provided
    let samplingRate = 100; // Default
    if (samplingRateOverride) {
        // CLI override takes priority (from manifest or explicit flag)
        samplingRate = samplingRateOverride;
        console.error(`Using sampling rate from CLI: ${samplingRate}`);
    }
    if (phaseFiles.length > 0) {
        console.error(`Reading ${phaseFiles.length} phase file pair(s)`);
        data.phaseData = readPhaseFiles(phaseFiles);
        if (!samplingRateOverride) {
            // Only read from phase files if not overridden
            samplingRate = readSamplingRate(phaseFiles);
        }
    }
    
    // Build command groups for validation and track cache usage
    const run = new Run();
    // Track cache usage per instance: { instanceId: { sampled: [], estimated: [] } }
    const cacheUsageByInstance = new Map();
    // Track blob cache usage per instance (same structure)
    const blobUsageByInstance = new Map();
    
    modSeqs.forEach((modSeq) => {
        const group = [];
        modSeq.mods.forEach((mod) => {
            const modType = mod[0];
            if (modMap[modType]) {
                group.push(() => modMap[modType](mod));
            }
        });
        run.command_groups.push(group);
    });
    
    // Execute to validate and track cache usage per frame
    cacheBlocksByInstance.clear();
    cacheKeyToFileInfo.clear();
    blobBlocksByInstance.clear();
    let frameIndex = 0;
    run.command_groups.forEach((group) => {
        group.forEach((command) => command());
        
        // Calculate cache usage at end of frame for each known instance
        // First, ensure all instances have an entry up to this frame
        for (const [instanceId, usage] of cacheUsageByInstance.entries()) {
            while (usage.sampled.length < frameIndex) {
                // Fill in missing frames with the last known value (or 0)
                const lastValue = usage.sampled.length > 0 ? usage.sampled[usage.sampled.length - 1] : 0;
                usage.sampled.push(lastValue);
                usage.estimated.push(lastValue * samplingRate);
            }
        }
        
        // Now record current frame's cache usage for each instance
        for (const [instanceId, blocks] of cacheBlocksByInstance.entries()) {
            let sampledSize = 0;
            for (const blockSize of blocks.values()) {
                sampledSize += blockSize;
            }
            
            if (!cacheUsageByInstance.has(instanceId)) {
                // New instance - backfill with zeros for previous frames
                const sampled = new Array(frameIndex).fill(0);
                const estimated = new Array(frameIndex).fill(0);
                cacheUsageByInstance.set(instanceId, { sampled, estimated });
            }
            const usage = cacheUsageByInstance.get(instanceId);
            usage.sampled.push(sampledSize);
            usage.estimated.push(sampledSize * samplingRate);
        }
        
        // For instances that had no activity this frame, carry forward
        for (const [instanceId, usage] of cacheUsageByInstance.entries()) {
            if (usage.sampled.length <= frameIndex) {
                const lastValue = usage.sampled.length > 0 ? usage.sampled[usage.sampled.length - 1] : 0;
                usage.sampled.push(lastValue);
                usage.estimated.push(lastValue * samplingRate);
            }
        }
        
        // === Blob cache usage tracking (same pattern as block cache) ===
        // Ensure all blob instances have an entry up to this frame
        for (const [instanceId, usage] of blobUsageByInstance.entries()) {
            while (usage.sampled.length < frameIndex) {
                const lastValue = usage.sampled.length > 0 ? usage.sampled[usage.sampled.length - 1] : 0;
                usage.sampled.push(lastValue);
                usage.estimated.push(lastValue * samplingRate);
            }
        }
        
        // Record current frame's blob cache usage for each instance
        for (const [instanceId, blocks] of blobBlocksByInstance.entries()) {
            let sampledSize = 0;
            for (const blockSize of blocks.values()) {
                sampledSize += blockSize;
            }
            
            if (!blobUsageByInstance.has(instanceId)) {
                const sampled = new Array(frameIndex).fill(0);
                const estimated = new Array(frameIndex).fill(0);
                blobUsageByInstance.set(instanceId, { sampled, estimated });
            }
            const usage = blobUsageByInstance.get(instanceId);
            usage.sampled.push(sampledSize);
            usage.estimated.push(sampledSize * samplingRate);
        }
        
        // For blob instances that had no activity this frame, carry forward
        for (const [instanceId, usage] of blobUsageByInstance.entries()) {
            if (usage.sampled.length <= frameIndex) {
                const lastValue = usage.sampled.length > 0 ? usage.sampled[usage.sampled.length - 1] : 0;
                usage.sampled.push(lastValue);
                usage.estimated.push(lastValue * samplingRate);
            }
        }
        
        frameIndex++;
    });
    
    // Build cache usage output
    // If only default instance exists, use simple format for backwards compatibility
    const instances = Array.from(cacheUsageByInstance.keys());
    if (instances.length === 0) {
        // No cache events at all
        data.cacheUsage = {
            sampled: [],
            estimated: [],
            samplingRate: samplingRate
        };
    } else if (instances.length === 1 && instances[0] === '') {
        // Only default instance, use simple format
        const usage = cacheUsageByInstance.get('');
        data.cacheUsage = {
            sampled: usage.sampled,
            estimated: usage.estimated,
            samplingRate: samplingRate
        };
    } else {
        // Multiple instances, use per-instance format
        const instancesData = {};
        for (const [instanceId, usage] of cacheUsageByInstance.entries()) {
            const key = instanceId === '' ? 'default' : instanceId;
            instancesData[key] = {
                sampled: usage.sampled,
                estimated: usage.estimated
            };
        }
        data.cacheUsage = {
            instances: instancesData,
            samplingRate: samplingRate
        };
    }
    
    // Build blob cache usage output (same structure as block cache)
    const blobInstances = Array.from(blobUsageByInstance.keys());
    if (blobInstances.length === 0) {
        // No blob cache events at all
        data.blobCacheUsage = {
            sampled: [],
            estimated: [],
            samplingRate: samplingRate
        };
    } else if (blobInstances.length === 1 && blobInstances[0] === '') {
        // Only default instance, use simple format
        const usage = blobUsageByInstance.get('');
        data.blobCacheUsage = {
            sampled: usage.sampled,
            estimated: usage.estimated,
            samplingRate: samplingRate
        };
    } else {
        // Multiple instances, use per-instance format
        const instancesData = {};
        for (const [instanceId, usage] of blobUsageByInstance.entries()) {
            const key = instanceId === '' ? 'default' : instanceId;
            instancesData[key] = {
                sampled: usage.sampled,
                estimated: usage.estimated
            };
        }
        data.blobCacheUsage = {
            instances: instancesData,
            samplingRate: samplingRate
        };
    }
    
    // Apply config overrides to metadata
    if (vizConfig) {
        // Override tier names from config
        if (vizConfig.tiers) {
            data.meta.tiers = vizConfig.tiers.map(t => t.name);
        }
        
        // Override labels/colors from config
        if (vizConfig.labels) {
            data.meta.labels = vizConfig.labels;
        }
        
        // Override phase names from config
        // If config provides phases, use them to either:
        // 1. Rename existing phases (if same count)
        // 2. Replace all phases (if config specifies single phase, treat whole trace as one phase)
        if (vizConfig.phases) {
            if (vizConfig.phases.length === 1) {
                // Single phase config: treat entire trace as one phase
                data.meta.phases = { "1": vizConfig.phases[0] };
            } else {
                // Multiple phases: rename detected phases
                const phaseIndices = Object.keys(data.meta.phases).sort((a, b) => parseInt(a) - parseInt(b));
                phaseIndices.forEach((idx, i) => {
                    if (vizConfig.phases[i]) {
                        data.meta.phases[idx] = vizConfig.phases[i];
                    }
                });
            }
        }
        
        // Override cache setting from config
        if (vizConfig.cache !== undefined) {
            data.meta.cache = vizConfig.cache;
        }
    }
    
    // Output
    const jsonOutput = JSON.stringify(data, null, 2);
    
    if (outputFile) {
        fs.writeFileSync(outputFile, jsonOutput);
        console.error(`Output written to: ${outputFile}`);
    } else {
        console.log(jsonOutput);
    }
    
    console.error(`Processed ${modSeqs.length} sequences`);
}

main();
