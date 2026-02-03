const fs = require('fs');
const readline = require('readline');


//modification sequence
class ModSequence {
    constructor() {
        this.mods = [];
    }

    //first comes "o", then "s" (size), then "m", then "l", then "h", then "e", then "u", 
    // Block cache events (C+/C-) come after file I/O (#/!) but before frame end
    compare(a, b) {
        const order = "osmlheu#!C"; // Custom order
        // Only compare the first character (line type) - return 0 for same type
        // to preserve original order via stable sort
        const indexA = order.indexOf(a[0]);
        const indexB = order.indexOf(b[0]);
        return indexA - indexB;
    }
    

    sort() {
        // sort string based on the custom order
        this.mods.sort((a, b) => this.compare(a, b));        
    }
}



const readModsFromFile = (file) => {

    let modSequences = [];

    // Input file path
    const filePath = file;

    let modSeq = new ModSequence();

    // Track phase markers: each "." followed by "---" marks a new phase
    // The frame index where each phase starts
    let phaseIndices = [];
    
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        const lines = data.split('\n');

        // First pass: find all phase markers and remove them
        // Each phase starts with ".\n---"
        let frameCount = 0;
        let cleanedLines = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            if (line === '.') {
                // This is a phase marker - record the frame index
                // The phase starts at the NEXT frame (after the ---)
                phaseIndices.push(frameCount);
                // Skip this line and the next "---" line
                if (i + 1 < lines.length && lines[i + 1].trim() === '---') {
                    i++; // Skip the "---" that follows the "."
                }
                continue;
            }
            
            if (line === '---') {
                frameCount++;
            }
            
            cleanedLines.push(lines[i]);
        }
        
        // Second pass: process the cleaned lines into sequences
        cleanedLines.forEach((line) => {
            if (line.trim() === '---') {
                modSeq.sort();
                modSequences.push(modSeq);
                modSeq = new ModSequence();
            } else if (line.trim() === '') {
                return;
            } else {
                modSeq.mods.push(line);
            }
        });
    } catch (err) {
        console.error('Error reading file:', err);
    }

    // Push the last sequence if it has content
    if (modSeq.mods.length > 0) {
        modSeq.sort();
        modSequences.push(modSeq);
    }

    // Build phases object from the detected phase indices
    // Each phase is named PHASE1, PHASE2, etc.
    const phases = {};
    phaseIndices.forEach((frameIndex, i) => {
        phases[frameIndex.toString()] = `PHASE${i}`;
    });
    
    // If no phases were found, default to PHASE1 at frame 0
    if (Object.keys(phases).length === 0) {
        phases["0"] = "PHASE0";
    }

    return {
        'meta': {
            'phases': phases,
            'tiers': ['NVME'],  // RocksDB tiers
            'cache': false,     // Block cache visualization disabled by default
            'labels': {
                '-1': 0x808080, // other files - gray
                '0': 0xFFFF00,  // L0 - yellow
                '1': 0x008000,  // L1 - green
                '2': 0x0000FF,  // L2 - blue
                '3': 0xFF8000,  // L3 - orange
                '4': 0xFF0000,  // L4 - red
                '5': 0xA020F0   // L5 - purple
            }
        },
        'sequences': modSequences
    };
}

module.exports = {
    ModSequence,
    readModsFromFile
};