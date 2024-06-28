

//read json file into a variable
const fs = require('fs');
let modSeqs = JSON.parse(fs.readFileSync('modSeqs.json'));




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

console.log(processSequences(modSeqs));