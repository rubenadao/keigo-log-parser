#!/usr/bin/env node
/**
 * Keigo Log Parser
 * Parses RocksDB visual profiler trace logs into JSON format for the Keigo visualizer.
 * 
 * Usage: node main.js <input_file> [output_file]
 *   input_file  - Path to the trace log file
 *   output_file - Path for the output JSON (default: stdout)
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

Usage: node main.js <input_file> [output_file]

Arguments:
  input_file   Path to the trace log file (required)
  output_file  Path for the output JSON file (optional, defaults to stdout)

Examples:
  node main.js trace.log                    # Output to stdout
  node main.js trace.log output.json        # Output to file
  node main.js trace.log ../keigo/src/traces/trace.json
`);
        process.exit(args.length === 0 ? 1 : 0);
    }
    
    return {
        inputFile: args[0],
        outputFile: args[1] || null
    };
}

// Tier and SST state
let tiers = [new Tier(1), new Tier(2), new Tier(3)];
let ssts = {};

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
    
    'z': () => {} // Tier stats - no-op
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
    const { inputFile, outputFile } = parseArgs();
    
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
    
    // Build command groups for validation
    const run = new Run();
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
    
    // Execute to validate
    run.command_groups.forEach((group) => {
        group.forEach((command) => command());
    });
    
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
