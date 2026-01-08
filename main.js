#!/usr/bin/env node
/**
 * Keigo Log Parser
 * Parses RocksDB visual profiler trace logs into JSON format for the Keigo visualizer.
 * 
 * Usage: node main.js <input_file> [output_file] [--phase <config_file> <perf_log_file>]...
 *   input_file  - Path to the trace log file
 *   output_file - Path for the output JSON (default: stdout)
 *   --phase     - Optional phase data: config file and performance log file pair
 */

const fs = require('fs');
const { Sst, Tier, Run } = require('./structs');
const { readModsFromFile } = require('./states');

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    
    if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
        console.log(`
Keigo Log Parser - Parse RocksDB trace logs for visualization

Usage: node main.js <input_file> [output_file] [--phase <config_file> <perf_log_file>]...

Arguments:
  input_file   Path to the trace log file (required)
  output_file  Path for the output JSON file (optional, defaults to stdout)
  --phase      Phase data pair: config file and performance log file (can be repeated)

Examples:
  node main.js trace.log                    # Output to stdout
  node main.js trace.log output.json        # Output to file
  node main.js trace.log output.json --phase loading.cfg loading_perf.log --phase exec.cfg exec_perf.log
`);
        process.exit(args.length === 0 ? 1 : 0);
    }
    
    let inputFile = null;
    let outputFile = null;
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
        phaseFiles
    };
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

// Get or create the cache blocks map for a given instance
function getCacheInstance(instanceId) {
    if (!cacheBlocksByInstance.has(instanceId)) {
        cacheBlocksByInstance.set(instanceId, new Map());
    }
    return cacheBlocksByInstance.get(instanceId);
}

const selectTier = (i) => i - 1;

// Command handlers
const modMap = {
    'o': (line) => {
        const match = /o ([^ ]+) (\d+) l([^ ]+)/.exec(line);
        if (!match) return;
        const [, number, tier, label] = match;
        if (ssts[number] === undefined) {
            const sst = new Sst(number);
            sst.label = label;
            sst.tier = tier;
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
        const match = /m ([^ ]+) (\d+) l([^ ]+)/.exec(line);
        if (!match) return;
        const [, number, tier, label] = match;
        const sst = ssts[number];
        if (!sst) return;
        sst.label = label;
        if (sst.tier === tier) return;
        tiers[selectTier(tier)].files.set(number, sst);
        tiers[selectTier(sst.tier)].files.delete(number);
        sst.tier = tier;
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
        // C-[N] <key_hex> <was_hit>                               - Block cache eviction (N is optional cache instance)
        if (line.startsWith('C+')) {
            // Match C+ or C+0, C+1, etc. followed by space
            const match = /C\+(\d*) ([^ ]+) (\d+) (\d+) ([^ ]+) ([a-f0-9]+)/.exec(line);
            if (!match) {
                console.error(`Warning: Invalid C+ line format: ${line}`);
                return;
            }
            const [, cacheInstance, sstFile, offset, size, type, cacheKey] = match;
            const blockSize = parseInt(size, 10);
            const instanceId = cacheInstance || ''; // '' for default instance
            getCacheInstance(instanceId).set(cacheKey, blockSize);
        } else if (line.startsWith('C-')) {
            // Match C- or C-0, C-1, etc. followed by space
            const match = /C-(\d*) ([a-f0-9]+) ([01])/.exec(line);
            if (!match) {
                console.error(`Warning: Invalid C- line format: ${line}`);
                return;
            }
            const [, cacheInstance, cacheKey, wasHit] = match;
            const instanceId = cacheInstance || ''; // '' for default instance
            const cacheBlocks = getCacheInstance(instanceId);
            cacheBlocks.delete(cacheKey);
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

// Main execution
function main() {
    const { inputFile, outputFile, phaseFiles } = parseArgs();
    
    // Check input file exists
    if (!fs.existsSync(inputFile)) {
        console.error(`Error: Input file not found: ${inputFile}`);
        process.exit(1);
    }
    
    console.error(`Parsing: ${inputFile}`);
    
    // Read and parse the trace file
    const data = readModsFromFile(inputFile);
    let modSeqs = data.sequences;
    
    // Process sequences
    modSeqs = processSequences(modSeqs);
    data.sequences = modSeqs;
    
    // Read phase files and sampling rate if provided
    let samplingRate = 100; // Default
    if (phaseFiles.length > 0) {
        console.error(`Reading ${phaseFiles.length} phase file pair(s)`);
        data.phaseData = readPhaseFiles(phaseFiles);
        samplingRate = readSamplingRate(phaseFiles);
    }
    
    // Build command groups for validation and track cache usage
    const run = new Run();
    // Track cache usage per instance: { instanceId: { sampled: [], estimated: [] } }
    const cacheUsageByInstance = new Map();
    
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
    run.command_groups.forEach((group) => {
        group.forEach((command) => command());
        
        // Calculate cache usage at end of frame for each instance
        for (const [instanceId, blocks] of cacheBlocksByInstance.entries()) {
            let sampledSize = 0;
            for (const blockSize of blocks.values()) {
                sampledSize += blockSize;
            }
            
            if (!cacheUsageByInstance.has(instanceId)) {
                cacheUsageByInstance.set(instanceId, { sampled: [], estimated: [] });
            }
            const usage = cacheUsageByInstance.get(instanceId);
            usage.sampled.push(sampledSize);
            usage.estimated.push(sampledSize * samplingRate);
        }
        
        // Ensure all known instances have an entry for this frame
        for (const [instanceId, usage] of cacheUsageByInstance.entries()) {
            if (usage.sampled.length < run.command_groups.indexOf(group) + 1) {
                // This instance had no activity this frame, carry forward previous value or 0
                const lastValue = usage.sampled.length > 0 ? usage.sampled[usage.sampled.length - 1] : 0;
                usage.sampled.push(lastValue);
                usage.estimated.push(lastValue * samplingRate);
            }
        }
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
