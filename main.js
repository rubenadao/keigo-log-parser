// import { Sst, Tier } from './structs.js';
const { Sst, Tier, Run } = require('./structs');
const { ModSequence, readModsFromFile } = require('./states');


let tiers = [new Tier(1), new Tier(2), new Tier(3)];
let ssts = {};

const selectTier = (i) => i-1;

const o = (line) => {
    // Regular expression pattern with a capturing group for matching email addresses
    const oRegex = /o (\d+) (\d+) l(\d+)/;
    // Executing the regular expression to match and capture groups
    const match = oRegex.exec(line);
    let number = match[1];
    let tier = match[2];
    let level = match[3];
    if (ssts[number] == undefined) {
        let sst = new Sst(number);
        sst.level = level;
        sst.tier = tier;
        tiers[selectTier(match[2])].files.set(number,sst);
        ssts[number] = sst;
    }
}

const m = (line) => {
    // Regular expression pattern with a capturing group for matching email addresses
    const oRegex = /m (\d+) (\d+) l(\d+)/;
    // Executing the regular expression to match and capture groups
    const match = oRegex.exec(line);
    let number = match[1];
    let tier = match[2];
    let level = match[3];
    let sst = ssts[number];
    sst.level = level;
    if (sst.tier == tier) return;
    tiers[selectTier(tier)].files.set(number,sst);
    //remove from previous tier
    tiers[selectTier(sst.tier)].files.delete(number);
    sst.tier = tier;
}

const h = (line) => {
    // Regular expression pattern with a capturing group for matching email addresses
    const oRegex = /h (\d+) (\d+)/;
    // Executing the regular expression to match and capture groups
    const match = oRegex.exec(line);
    let number = match[1];
    let tier = match[2];
    let sst = ssts[number];

    tiers[selectTier(tier)].cache.set(number,sst);
}

const hit = (line) => {
    // Regular expression pattern with a capturing group for matching email addresses
    const oRegex = /# (\d+) (\d+)/;
    // Executing the regular expression to match and capture groups
    const match = oRegex.exec(line);
    let number = match[1];
    let hits = match[2];
    let sst = ssts[number];

    if (sst == undefined) return;

    sst.hits = hits;
}


const e = (line) => {
    // Regular expression pattern with a capturing group for matching email addresses
    const oRegex = /e (\d+) (\d+)/;
    // Executing the regular expression to match and capture groups
    const match = oRegex.exec(line);
    let number = match[1];
    let tier = match[2];
    let sst = ssts[number];

    tiers[selectTier(tier)].cache.delete(number);
}

const u = (line) => {
    // Regular expression pattern with a capturing group for matching email addresses
    const oRegex = /u (\d+)/;
    // Executing the regular expression to match and capture groups
    const match = oRegex.exec(line);
    let number = match[1];
    let sst = ssts[number];
    if (sst == undefined) return;
    //go through every tier's cache and remove the sst
    tiers.forEach((tier) => {
        tier.cache.delete(number);
    });

    tiers[selectTier(sst.tier)].files.delete(number);
}

const l = (line) => {
    // Regular expression pattern with a capturing group for matching email addresses
    const oRegex = /l (\d+) l(\d+)/;
    // Executing the regular expression to match and capture groups
    const match = oRegex.exec(line);
    let number = match[1];
    let level = match[2];
    let sst = ssts[number];

    sst.level = level;
}

const newphase = (line) => {
    // Regular expression pattern with a capturing group for matching email addresses
    
}

modMap = {
    "o": o,
    "m": m,
    "h": h,
    "e": e,
    "u": u,
    "l": l,
    "#" : hit
}


//CUIDADO, QUANDO UM SST É REMOVIDO, ELE DEVE SER REMOVIDO DA CACHE TBM

// let modSeqs = readModsFromFile('example_run.txt');
// modSeqs.forEach((modSeq) => {
//     modSeq.mods.forEach((mod) => {
//         console.log(mod);
//         let modType = mod[0];
//         modMap[modType](mod);
//     });
// });


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

    console.log(sequences)

    let exec_phase = undefined;
    let index = 0;
    sequences.forEach(seq => {
        const currentHits = extractHits(seq.mods);

        previousHits.forEach(sst => {
            if (!currentHits.has(sst)) {
                seq.mods.push(`# ${sst} 0`);
            }
        });

        processedSequences.push(seq);
        previousHits = currentHits;

        // //new phase
        // if (seq.mods[0] == '.') {
        //     exec_phase = index;
        // }

        index++;
    });

    return processedSequences;
}



let run = new Run();

let data = readModsFromFile('/home/user/Documents/keigo-visualizer/data/leveldb6/log_profiler_3000.txt');

let modSeqs = data.sequences;

// let modSeqs = readModsFromFile('/home/user/Documents/keigo-visualizer/data/50/run1.txt');


// let modSeqs = readModsFromFile('./backup/example_run.txt');


modSeqs = processSequences(modSeqs);

data.sequences = modSeqs;

//dump modSeqs as a json file
const fs = require('fs');
fs.writeFileSync('modSeqs.json', JSON.stringify(data));




modSeqs.forEach((modSeq) => {
    let group = [];

    
    // console.log("modSeq");

    modSeq.mods.forEach((mod) => {
        // console.log(mod);
        let modType = mod[0];
        // first word

        // modMap[modType](mod);
        group.push(() => modMap[modType](mod));
    });


    run.command_groups.push(group);
});

// console.log(run.command_groups);


run.command_groups.forEach((group) => {
    group.forEach((command) => {
        command();
        
    });
});

// console.log(tiers);
// console.log(ssts);


// console.log(`command_group length: ${run.command_groups.length}`);