const fs = require('fs');
const readline = require('readline');


//modification sequence
class ModSequence {
    constructor() {
        this.mods = [];
    }

    //first comes "o", then "m", then "l", then "h", then "e", then "u", 
    compare(a, b) {
        const order = "omlheu#"; // Custom order
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            const indexA = order.indexOf(a[i]);
            const indexB = order.indexOf(b[i]);
            if (indexA !== indexB) {
                return indexA - indexB;
            }
        }
        return a.length - b.length;
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


    let exec_phase_index = undefined;
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        const lines = data.split('\n');

        //find the line equal to "." while also counting how many --- there are before it and return both
        //the index of the line and the number of "---" before it
        let i = 0;
        let count = 0;
        for (i = 0; i < lines.length; i++) {
            if (lines[i].trim() === '.') {
                exec_phase_index = count;
                break;
            } else if (lines[i].trim() === '---') {
                count++;
            }
        }
        if (count > 0) {
            exec_phase_index = count + 1;
        }
        //remove the line equal to "." and the one next to it
        lines.splice(i, 2);

        
        // Process each line
        lines.forEach((line) => {
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

    modSequences.push(modSeq);
    console.log(modSequences);
    console.log('File processed');

    return {'meta':{'exec_phase':exec_phase_index}, 'sequences' : modSequences};
}

module.exports = {
    ModSequence,
    readModsFromFile
};