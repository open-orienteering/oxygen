import * as fs from 'fs';

const filePath = '/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd';
const fileData = fs.readFileSync(filePath);

const s = new Set<string>();

let i = 0;
// We will scan the entire file exactly once
while (i < fileData.length) {
    let start = i;
    while (i < fileData.length && fileData[i] !== 0) {
        i++;
    }

    if (i > start) {
        const txt = fileData.slice(start, i).toString("utf8");
        if (txt.startsWith("1\t") || txt.startsWith("2\t")) {
            console.log("COURSE DECL:", txt.replace(/\n|\r|\t/g, " | "));
        }
    }
    i++;
}

